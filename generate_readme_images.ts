import "https://deno.land/x/dotenv@v0.5.0/load.ts";

import { GithubApiService } from "./src/Services/GithubApiService.ts";
import { Card } from "./src/card.ts";
import { COLORS } from "./src/theme.ts";

const username = Deno.args[0] ?? "rstar327";
const outputDir = Deno.args[1] ?? "./images";

const themes = Object.keys(COLORS);

const examples = [
  { name: "quickstart", column: 6, row: 3 },
  { name: "theme_onedark_example", column: 6, row: 3, theme: "onedark" },
  { name: "filter_followers", column: 6, row: 3, titles: ["Followers"] },
  {
    name: "filter_stars_followers",
    column: 6,
    row: 3,
    titles: ["Stars", "Followers"],
  },
  { name: "filter_rank_s", column: 6, row: 3, ranks: ["S"] },
  { name: "filter_rank_s_aaa", column: 6, row: 3, ranks: ["S", "AAA"] },
  { name: "row2_column3", column: 3, row: 2 },
  { name: "margin_w", column: 6, row: 3, marginW: 10 },
  { name: "margin_h", column: 6, row: 3, marginH: 10 },
  { name: "example_layout", column: 6, row: 3, marginW: 5, marginH: 5 },
  { name: "no_bg", column: 6, row: 3, noBg: true },
  { name: "no_frame", column: 6, row: 3, noFrame: true },
];

async function main() {
  const svc = new GithubApiService();
  const userInfo = (await svc.requestUserInfo(username)) as any;

  if (!userInfo || userInfo.totalCommits === undefined) {
    console.error(
      "Failed to fetch user info. Check token, username and rate limits.",
    );
    Deno.exit(1);
  }

  await Deno.mkdir(outputDir, { recursive: true });

  // Generate theme SVGs
  for (const themeName of themes) {
    const card = new Card([], [], -1, 10, 115, 10, 10, false, false);
    const theme = COLORS[themeName];
    const svg = card.render(userInfo, theme);
    const filePath = `${outputDir}/${themeName}.svg`;
    await Deno.writeTextFile(filePath, svg);
    console.log(`Generated: ${filePath}`);
  }

  // Generate example SVGs
  for (const ex of examples) {
    const theme = COLORS[ex.theme ?? "default"];
    const card = new Card(
      ex.titles ?? [],
      ex.ranks ?? [],
      ex.column,
      ex.row,
      115,
      ex.marginW ?? 0,
      ex.marginH ?? 0,
      ex.noBg ?? false,
      ex.noFrame ?? false,
    );
    const svg = card.render(userInfo, theme);
    const filePath = `${outputDir}/${ex.name}.svg`;
    await Deno.writeTextFile(filePath, svg);
    console.log(`Generated: ${filePath}`);
  }
}

await main();
