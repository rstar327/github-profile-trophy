import { GithubRepository } from "../Repository/GithubRepository.ts";
import {
  GitHubUserActivity,
  GitHubUserIssue,
  GitHubUserPullRequest,
  GitHubUserRepository,
  UserInfo,
} from "../user_info.ts";
import {
  queryUserActivity,
  queryUserActivityWithDateRange,
  queryUserIssue,
  queryUserPullRequest,
  queryUserRepository,
  queryUserRepositoryAllTime,
} from "../Schemas/index.ts";
import { Retry } from "../Helpers/Retry.ts";
import { CONSTANTS } from "../utils.ts";
import { EServiceKindError, ServiceError } from "../Types/index.ts";
import { Logger } from "../Helpers/Logger.ts";
import { requestGithubData } from "./request.ts";

// Need to be here - Exporting from another file makes array of null
export const TOKENS = [
  Deno.env.get("GITHUB_TOKEN1"),
  Deno.env.get("GITHUB_TOKEN2"),
];

// Constants for batched parallel fetching
const BATCH_CONCURRENCY = 3;
const YEAR_QUERY_MAX_RETRIES = 3;
const YEAR_QUERY_BASE_DELAY = 1000;

type YearData = {
  year: number;
  data: GitHubUserActivity;
};

type YearError = {
  year: number;
  error: ServiceError;
};

type YearResult = YearData | YearError;

/**
 * Type guard that determines whether a YearResult represents an error.
 *
 * @param result - The year result to test
 * @returns `true` if `result` is a `YearError`, `false` otherwise
 */
function isYearError(result: YearResult): result is YearError {
  return "error" in result;
}

/**
 * Process an array of items in parallel batches constrained by a concurrency limit.
 *
 * Each batch of up to `concurrency` items is processed in parallel; batches are executed sequentially.
 *
 * @param items - The input items to process.
 * @param concurrency - Maximum number of items processed in parallel per batch.
 * @param processor - Async function applied to each item that produces a result.
 * @returns An array of results corresponding to `items` in the same order. 
 */
async function processBatched<T, R>(
  items: T[],
  concurrency: number,
  processor: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }
  return results;
}

/**
 * Compute the exponential backoff delay.
 *
 * @param attempt - Zero-based retry attempt index (0 yields `baseDelay`)
 * @param baseDelay - Base delay in milliseconds
 * @returns The delay in milliseconds calculated as `baseDelay * 2^attempt`
 */
function getBackoffDelay(attempt: number, baseDelay: number): number {
  return baseDelay * Math.pow(2, attempt);
}

export class GithubApiService extends GithubRepository {
  async requestUserRepository(
    username: string,
    alltime = false,
  ): Promise<GitHubUserRepository | ServiceError> {
    const query = alltime ? queryUserRepositoryAllTime : queryUserRepository;
    return await this.executeQuery<GitHubUserRepository>(query, {
      username,
    });
  }
  async requestUserActivity(
    username: string,
    alltime = false,
  ): Promise<GitHubUserActivity | ServiceError> {
    if (!alltime) {
      return await this.executeQuery<GitHubUserActivity>(queryUserActivity, {
        username,
      });
    }

    // For alltime, first get account creation date
    const initialData = await this.executeQuery<GitHubUserActivity>(
      queryUserActivity,
      { username },
    );
    if (initialData instanceof ServiceError) {
      return initialData;
    }

    const createdAt = new Date(initialData.createdAt);
    const now = new Date();
    const startYear = createdAt.getFullYear();
    const currentYear = now.getFullYear();

    // Build array of years to fetch
    const years: number[] = [];
    for (let year = startYear; year <= currentYear; year++) {
      years.push(year);
    }

    // Fetch year data with retry and backoff
    const fetchYearWithRetry = async (year: number): Promise<YearResult> => {
      const from = new Date(year, 0, 1).toISOString();
      const to = new Date(year, 11, 31, 23, 59, 59).toISOString();

      let lastError: ServiceError | null = null;

      for (let attempt = 0; attempt < YEAR_QUERY_MAX_RETRIES; attempt++) {
        const yearData = await this.executeQuery<GitHubUserActivity>(
          queryUserActivityWithDateRange,
          { username, from, to },
        );

        if (!(yearData instanceof ServiceError)) {
          return { year, data: yearData };
        }

        lastError = yearData;

        // Check if it's a rate limit error (419) - apply backoff
        if (yearData.code === 419) {
          const delay = getBackoffDelay(attempt, YEAR_QUERY_BASE_DELAY);
          Logger.error(
            `Rate limit hit for year ${year}, attempt ${attempt + 1}/${YEAR_QUERY_MAX_RETRIES}, waiting ${delay}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // For non-rate-limit errors, retry with shorter delay
        if (attempt < YEAR_QUERY_MAX_RETRIES - 1) {
          const delay = getBackoffDelay(attempt, YEAR_QUERY_BASE_DELAY / 2);
          Logger.error(
            `Error fetching year ${year}, attempt ${attempt + 1}/${YEAR_QUERY_MAX_RETRIES}, retrying in ${delay}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      return {
        year,
        error: lastError ??
          new ServiceError(
            `Failed to fetch data for year ${year}`,
            EServiceKindError.NOT_FOUND,
          ),
      };
    };

    // Process years in batches with concurrency limit
    const results = await processBatched(
      years,
      BATCH_CONCURRENCY,
      fetchYearWithRetry,
    );

    // Check for any errors and surface them
    const errors = results.filter(isYearError);
    if (errors.length > 0) {
      const failedYears = errors.map((e) => e.year).join(", ");
      Logger.error(
        `Failed to fetch contribution data for years: ${failedYears}`,
      );
      // Return the first error encountered, preserving its error kind
      const firstError = errors[0].error;
      const errorKind = (firstError.cause as EServiceKindError) ??
        EServiceKindError.NOT_FOUND;
      return new ServiceError(
        `Failed to fetch all-time data (years failed: ${failedYears})`,
        errorKind,
      );
    }

    // Aggregate successful results
    let totalCommits = 0;
    let totalRestricted = 0;
    let totalReviews = 0;

    for (const result of results) {
      if (!isYearError(result)) {
        totalCommits +=
          result.data.contributionsCollection.totalCommitContributions;
        totalRestricted +=
          result.data.contributionsCollection.restrictedContributionsCount;
        totalReviews +=
          result.data.contributionsCollection.totalPullRequestReviewContributions;
      }
    }

    // Return aggregated data
    return {
      createdAt: initialData.createdAt,
      contributionsCollection: {
        totalCommitContributions: totalCommits,
        restrictedContributionsCount: totalRestricted,
        totalPullRequestReviewContributions: totalReviews,
      },
      organizations: initialData.organizations,
      followers: initialData.followers,
    };
  }
  async requestUserIssue(
    username: string,
  ): Promise<GitHubUserIssue | ServiceError> {
    return await this.executeQuery<GitHubUserIssue>(queryUserIssue, {
      username,
    });
  }
  async requestUserPullRequest(
    username: string,
  ): Promise<GitHubUserPullRequest | ServiceError> {
    return await this.executeQuery<GitHubUserPullRequest>(
      queryUserPullRequest,
      { username },
    );
  }
  async requestUserInfo(
    username: string,
    alltime = false,
  ): Promise<UserInfo | ServiceError> {
    // Avoid to call others if one of them is null

    const promises = Promise.allSettled([
      this.requestUserRepository(username, alltime),
      this.requestUserActivity(username, alltime),
      this.requestUserIssue(username),
      this.requestUserPullRequest(username),
    ]);
    try {
      const [repository, activity, issue, pullRequest] = await promises;
      const status = [
        repository.status,
        activity.status,
        issue.status,
        pullRequest.status,
      ];

      if (status.includes("rejected")) {
        Logger.error(`Can not find a user with username:' ${username}'`);
        return new ServiceError("Not found", EServiceKindError.NOT_FOUND);
      }

      return new UserInfo(
        (activity as PromiseFulfilledResult<GitHubUserActivity>).value,
        (issue as PromiseFulfilledResult<GitHubUserIssue>).value,
        (pullRequest as PromiseFulfilledResult<GitHubUserPullRequest>).value,
        (repository as PromiseFulfilledResult<GitHubUserRepository>).value,
      );
    } catch {
      Logger.error(`Error fetching user info for username: ${username}`);
      return new ServiceError("Not found", EServiceKindError.NOT_FOUND);
    }
  }

  async executeQuery<T = unknown>(
    query: string,
    variables: { [key: string]: string },
  ) {
    try {
      const retry = new Retry(
        TOKENS.length,
        CONSTANTS.DEFAULT_GITHUB_RETRY_DELAY,
      );
      return await retry.fetch<Promise<T>>(async ({ attempt }) => {
        return await requestGithubData(
          query,
          variables,
          TOKENS[attempt],
        );
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.cause instanceof ServiceError) {
        Logger.error(error.cause.message);
        return error.cause;
      }
      if (error instanceof Error && error.cause) {
        Logger.error(JSON.stringify(error.cause, null, 2));
      } else {
        Logger.error(String(error));
      }
      return new ServiceError("not found", EServiceKindError.NOT_FOUND);
    }
  }
}