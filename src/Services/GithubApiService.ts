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

    let totalCommits = 0;
    let totalRestricted = 0;
    let totalReviews = 0;

    // Fetch contributions for each year
    for (let year = startYear; year <= currentYear; year++) {
      const from = new Date(year, 0, 1).toISOString();
      const to = new Date(year, 11, 31, 23, 59, 59).toISOString();

      const yearData = await this.executeQuery<GitHubUserActivity>(
        queryUserActivityWithDateRange,
        { username, from, to },
      );

      if (!(yearData instanceof ServiceError)) {
        totalCommits +=
          yearData.contributionsCollection.totalCommitContributions;
        totalRestricted +=
          yearData.contributionsCollection.restrictedContributionsCount;
        totalReviews +=
          yearData.contributionsCollection.totalPullRequestReviewContributions;
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
    } catch (error) {
      if (error.cause instanceof ServiceError) {
        Logger.error(error.cause.message);
        return error.cause;
      }
      if (error instanceof Error && error.cause) {
        Logger.error(JSON.stringify(error.cause, null, 2));
      } else {
        Logger.error(error);
      }
      return new ServiceError("not found", EServiceKindError.NOT_FOUND);
    }
  }
}
