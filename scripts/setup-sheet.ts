/**
 * setup-sheet.ts
 *
 * Creates and configures the Zero Budget Google Sheet from code.
 * Run with: npm run setup:dev  OR  npm run setup:prod
 *
 * The sheet is infrastructure — re-running this script is always safe.
 * It checks before overwriting and never deletes existing data.
 */

import * as path from "path";
import * as fs from "fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { google, sheets_v4 } from "googleapis";
import { handleRemovedCategory } from "./category-utils";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Category {
  name: string;
  type: "fluid" | "fixed_bill" | "savings_target";
  template?: number;
  sort_order?: number;
  active?: boolean;
}

interface Subgroup {
  name: string;
  sort_order?: number;
  categories: Category[];
}

interface Group {
  name: string;
  sort_order?: number;
  subgroups?: Subgroup[];
  categories?: Category[];
}

interface CategoriesConfig {
  version: number;
  groups: Group[];
}

interface FlatCategory {
  group: string;
  subgroup: string;
  category: string;
  type: string;
  template: number;
  sort_order: number;
  active: boolean;
}

// ─── Tab & Column Definitions ─────────────────────────────────────────────────

const TRANSACTIONS_COLUMNS = [
  "transaction_id",
  "parent_id",
  "split_group_id",
  "source",
  "external_id",
  "imported_at",
  "status",
  "date",
  "payee",
  "description",
  "category",
  "suggested_category",
  "category_subgroup",
  "category_group",
  "category_type",
  "outflow",
  "inflow",
  "account",
  "memo",
  "transaction_type",
  "transfer_pair_id",
  "flag",
  "needs_reimbursement",
  "reimbursement_amount",
  "matched_id",
  "reviewed",
];

const BUDGET_CATEGORY_COLUMNS = [
  "category_group",
  "category_subgroup",
  "category",
  "category_type",
  "monthly_template_amount",
  "sort_order",
  "active",
];

// Budget tab layout:
//   Rows 1–5:   Dashboard header (ReadyToAssign, LastYnabSync, etc.)
//   Row 6:      Category column headers
//   Rows 7–506: Category data (500 rows reserved)
//   Row 507:    "── Monthly Assignments ──" section label
//   Row 508:    Assignment column headers
//   Rows 509+:  Assignment data rows
const BUDGET_CATEGORIES_HEADER_ROW = 6;
const BUDGET_CATEGORIES_START_ROW = 7;
const BUDGET_CATEGORIES_END_ROW = 506;
const BUDGET_ASSIGNMENTS_START_ROW = 508; // header row; data starts at 509
const BUDGET_ASSIGNMENTS_COLUMNS = ["month", "category", "assigned", "source"];

const TEMPLATES_COLUMNS = [
  "template_id",
  "parent_id",
  "name",
  "match_payee",
  "match_amount",
  "match_account",
  "active",
  "split_payee",
  "category",
  "amount",
];

const BUDGET_LOG_COLUMNS = [
  "timestamp",
  "month",
  "category",
  "amount",
  "change_type",
  "note",
];

const TABS_IN_ORDER = [
  "Transactions",
  "Budget",
  "Templates",
  "Reflect",
  "Budget_Log",
  "Budget_Calcs",
  "Transactions (BTS)",
  "Balance History (BTS)",
  "YNAB_Plan_Import",
  "YNAB_Transactions_Import",
];

const BUDGET_CALCS_COLUMNS = ["month", "category", "activity", "assigned", "available"];

// How many months back/forward from today to generate Budget_Calcs rows.
const CALCS_MONTHS_BACK = 36;
const CALCS_MONTHS_FORWARD = 24;

// Header background color (Google blue)
const HEADER_BG_COLOR = { red: 0.29, green: 0.525, blue: 0.91 };
const HEADER_FG_COLOR = { red: 1, green: 1, blue: 1 };

// Sheet schema version — increment when structure changes
const SHEET_VERSION = 5;

// ─── Environment Loading ───────────────────────────────────────────────────────

type AuthConfig =
  | { kind: "keyFile"; keyPath: string }
  | { kind: "credentials"; credentials: object };

function loadEnv(): { sheetId: string; authConfig: AuthConfig } {
  const args = process.argv.slice(2);
  const envFlag = args.find((a) => a.startsWith("--env=") || a === "--env");
  let envName: string;

  if (envFlag === "--env") {
    const idx = args.indexOf("--env");
    envName = args[idx + 1];
  } else if (envFlag?.startsWith("--env=")) {
    envName = envFlag.split("=")[1];
  } else {
    envName = "dev";
  }

  if (!["dev", "prod"].includes(envName)) {
    bail(`Invalid --env value "${envName}". Use "dev" or "prod".`);
  }

  const envFile =
    envName === "dev" ? ".env.development" : ".env.production";
  const envPath = path.resolve(process.cwd(), envFile);

  // Load .env file if present — env vars already in the environment take precedence
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
    log(`Loaded env from ${envFile}`);
  } else {
    log(`No ${envFile} found — using environment variables`);
  }

  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId || sheetId === "your_sheet_id_here") {
    bail(`GOOGLE_SHEET_ID is not set. Add it to ${envFile} or set it as an environment variable.`);
  }

  // Auth: prefer inline JSON key (cloud-friendly), fall back to key file path (local)
  const inlineKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const keyFilePath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;

  let authConfig: AuthConfig;

  if (inlineKey) {
    let credentials: object;
    try {
      credentials = JSON.parse(inlineKey);
    } catch {
      bail(`GOOGLE_SERVICE_ACCOUNT_KEY is set but is not valid JSON.`);
    }
    log(`Auth: using inline service account key (GOOGLE_SERVICE_ACCOUNT_KEY)`);
    authConfig = { kind: "credentials", credentials };
  } else if (keyFilePath) {
    const resolvedKeyPath = path.resolve(process.cwd(), keyFilePath);
    if (!fs.existsSync(resolvedKeyPath)) {
      bail(
        `Service account key file not found: ${resolvedKeyPath}\n` +
          `Download it from Google Cloud Console → IAM → Service Accounts → Keys.`
      );
    }
    log(`Auth: using key file (GOOGLE_SERVICE_ACCOUNT_KEY_PATH)`);
    authConfig = { kind: "keyFile", keyPath: resolvedKeyPath };
  } else {
    bail(
      `No credentials found. Set either:\n` +
        `  GOOGLE_SERVICE_ACCOUNT_KEY    — JSON key contents (recommended for cloud)\n` +
        `  GOOGLE_SERVICE_ACCOUNT_KEY_PATH — path to JSON key file (local)`
    );
  }

  log(`Sheet ID: ${sheetId}`);
  return { sheetId, authConfig };
}

// ─── Categories Validation ────────────────────────────────────────────────────

function loadAndValidateCategories(): CategoriesConfig {
  const schemaPath = path.resolve(process.cwd(), "config/categories.schema.json");
  const dataPath = path.resolve(process.cwd(), "config/categories.json");

  if (!fs.existsSync(schemaPath)) bail(`Missing config/categories.schema.json`);
  if (!fs.existsSync(dataPath)) bail(`Missing config/categories.json`);

  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
  const data: CategoriesConfig = JSON.parse(fs.readFileSync(dataPath, "utf-8"));

  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  if (!validate(data)) {
    const errors = validate.errors
      ?.map((e) => `  ${e.instancePath || "root"}: ${e.message}`)
      .join("\n");
    bail(`config/categories.json is invalid:\n${errors}`);
  }

  log(`Validated categories.json (version ${data.version}, ${data.groups.length} groups)`);
  return data;
}

function flattenCategories(config: CategoriesConfig): FlatCategory[] {
  const flat: FlatCategory[] = [];
  let globalSortOrder = 0;

  for (const group of config.groups) {
    if (group.subgroups) {
      for (const subgroup of group.subgroups) {
        for (const cat of subgroup.categories) {
          flat.push({
            group: group.name,
            subgroup: subgroup.name,
            category: cat.name,
            type: cat.type,
            template: cat.template ?? 0,
            sort_order: cat.sort_order ?? ++globalSortOrder,
            active: cat.active ?? true,
          });
        }
      }
    } else if (group.categories) {
      for (const cat of group.categories) {
        flat.push({
          group: group.name,
          subgroup: "",
          category: cat.name,
          type: cat.type,
          template: cat.template ?? 0,
          sort_order: cat.sort_order ?? ++globalSortOrder,
          active: cat.active ?? true,
        });
      }
    }
  }

  return flat;
}

// ─── Google Sheets Helpers ────────────────────────────────────────────────────

async function getSheetMetadata(
  sheets: sheets_v4.Sheets,
  sheetId: string
): Promise<sheets_v4.Schema$Sheet[]> {
  const res = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: "sheets(properties(sheetId,title,hidden))",
  });
  return res.data.sheets ?? [];
}

function findSheet(
  metadata: sheets_v4.Schema$Sheet[],
  title: string
): sheets_v4.Schema$Sheet | undefined {
  return metadata.find((s) => s.properties?.title === title);
}

// ─── Step: Ensure Tabs Exist ──────────────────────────────────────────────────

async function ensureTabsExist(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  existing: sheets_v4.Schema$Sheet[]
): Promise<sheets_v4.Schema$Sheet[]> {
  const existingTitles = new Set(
    existing.map((s) => s.properties?.title ?? "")
  );
  const toCreate = TABS_IN_ORDER.filter((t) => !existingTitles.has(t));

  if (toCreate.length === 0) {
    log("Tabs: all exist, skipping creation");
    return existing;
  }

  const requests: sheets_v4.Schema$Request[] = toCreate.map((title) => ({
    addSheet: { properties: { title } },
  }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests },
  });

  log(`Tabs created: ${toCreate.join(", ")}`);

  // Refresh metadata
  return getSheetMetadata(sheets, sheetId);
}

// ─── Step: Write Headers ──────────────────────────────────────────────────────

async function writeHeaders(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[]
): Promise<void> {
  // Check existing header row for each tab that gets column headers.
  // Budget category header lives at row BUDGET_CATEGORIES_HEADER_ROW (not row 1).
  const tabHeaders: Array<{ title: string; columns: string[]; headerRow: number }> = [
    { title: "Transactions", columns: TRANSACTIONS_COLUMNS, headerRow: 1 },
    { title: "Budget", columns: BUDGET_CATEGORY_COLUMNS, headerRow: BUDGET_CATEGORIES_HEADER_ROW },
    { title: "Templates", columns: TEMPLATES_COLUMNS, headerRow: 1 },
    { title: "Budget_Log", columns: BUDGET_LOG_COLUMNS, headerRow: 1 },
  ];

  const formatRequests: sheets_v4.Schema$Request[] = [];

  for (const { title, columns, headerRow } of tabHeaders) {
    const meta = findSheet(sheetMeta, title);
    if (!meta) continue;

    const tabSheetId = meta.properties?.sheetId!;

    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${title}!${headerRow}:${headerRow}`,
    });

    const currentValues = existing.data.values?.[0] ?? [];

    if (currentValues.length > 0) {
      log(`Headers: ${title} row ${headerRow} already has headers, skipping`);
    } else {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${title}!A${headerRow}`,
        valueInputOption: "RAW",
        requestBody: { values: [columns] },
      });
      log(`Headers: wrote ${columns.length} columns to ${title} row ${headerRow}`);
    }

    const frozenRows = title === "Budget" ? BUDGET_CATEGORIES_HEADER_ROW : 1;

    // Format header row: bold, background color
    formatRequests.push(
      {
        repeatCell: {
          range: {
            sheetId: tabSheetId,
            startRowIndex: headerRow - 1,
            endRowIndex: headerRow,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: HEADER_BG_COLOR,
              textFormat: {
                foregroundColor: HEADER_FG_COLOR,
                bold: true,
              },
            },
          },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      },
      {
        updateSheetProperties: {
          properties: {
            sheetId: tabSheetId,
            gridProperties: { frozenRowCount: frozenRows },
          },
          fields: "gridProperties.frozenRowCount",
        },
      }
    );
  }

  // Write Budget monthly assignments header at BUDGET_ASSIGNMENTS_START_ROW
  const budgetMeta = findSheet(sheetMeta, "Budget");
  if (budgetMeta) {
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `Budget!A${BUDGET_ASSIGNMENTS_START_ROW}:D${BUDGET_ASSIGNMENTS_START_ROW}`,
    });
    if (!existing.data.values?.[0]?.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `Budget!A${BUDGET_ASSIGNMENTS_START_ROW}`,
        valueInputOption: "RAW",
        requestBody: { values: [BUDGET_ASSIGNMENTS_COLUMNS] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `Budget!A${BUDGET_ASSIGNMENTS_START_ROW - 1}`,
        valueInputOption: "RAW",
        requestBody: { values: [["── Monthly Assignments ──"]] },
      });
      log(`Headers: wrote monthly assignments header to Budget row ${BUDGET_ASSIGNMENTS_START_ROW}`);

      formatRequests.push({
        repeatCell: {
          range: {
            sheetId: budgetMeta.properties?.sheetId!,
            startRowIndex: BUDGET_ASSIGNMENTS_START_ROW - 1,
            endRowIndex: BUDGET_ASSIGNMENTS_START_ROW,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: HEADER_BG_COLOR,
              textFormat: {
                foregroundColor: HEADER_FG_COLOR,
                bold: true,
              },
            },
          },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      });
    } else {
      log("Headers: Budget monthly assignments already present, skipping");
    }
  }

  if (formatRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: formatRequests },
    });
    log("Headers: applied bold + color formatting and frozen rows");
  }
}

// ─── Step: Set Column Widths ──────────────────────────────────────────────────

async function setColumnWidths(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[]
): Promise<void> {
  const txMeta = findSheet(sheetMeta, "Transactions");
  if (!txMeta) return;

  const tabSheetId = txMeta.properties?.sheetId!;

  // Map column index → pixel width for Transactions tab
  const widths: Record<number, number> = {
    0: 220, // transaction_id
    1: 220, // parent_id
    2: 220, // split_group_id
    3: 110, // source
    4: 220, // external_id
    5: 160, // imported_at
    6: 90,  // status
    7: 100, // date
    8: 200, // payee
    9: 280, // description
    10: 180, // category
    11: 180, // suggested_category
    12: 160, // category_subgroup
    13: 160, // category_group
    14: 130, // category_type
    15: 90,  // outflow
    16: 90,  // inflow
    17: 160, // account
    18: 240, // memo
    19: 130, // transaction_type
    20: 220, // transfer_pair_id
    21: 80,  // flag
    22: 160, // needs_reimbursement
    23: 160, // reimbursement_amount
    24: 220, // matched_id
    25: 90,  // reviewed
  };

  const requests: sheets_v4.Schema$Request[] = Object.entries(widths).map(
    ([col, width]) => ({
      updateDimensionProperties: {
        range: {
          sheetId: tabSheetId,
          dimension: "COLUMNS",
          startIndex: Number(col),
          endIndex: Number(col) + 1,
        },
        properties: { pixelSize: width },
        fields: "pixelSize",
      },
    })
  );

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests },
  });
  log("Column widths: set for Transactions tab");
}

// ─── Step: Conditional Formatting ─────────────────────────────────────────────

async function applyConditionalFormatting(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[]
): Promise<void> {
  const txMeta = findSheet(sheetMeta, "Transactions");
  if (!txMeta) return;

  const tabSheetId = txMeta.properties?.sheetId!;

  // Column indices (0-based)
  const STATUS_COL = TRANSACTIONS_COLUMNS.indexOf("status");
  const CATEGORY_COL = TRANSACTIONS_COLUMNS.indexOf("category");

  const green = { red: 0.714, green: 0.843, blue: 0.659 };
  const yellow = { red: 1.0, green: 0.949, blue: 0.8 };
  const lightGray = { red: 0.898, green: 0.898, blue: 0.898 };
  const lightRed = { red: 0.988, green: 0.812, blue: 0.792 };

  const requests: sheets_v4.Schema$Request[] = [
    // status = "cleared" → green
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId: tabSheetId, startRowIndex: 1, startColumnIndex: STATUS_COL, endColumnIndex: STATUS_COL + 1 }],
          booleanRule: {
            condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "cleared" }] },
            format: { backgroundColor: green },
          },
        },
        index: 0,
      },
    },
    // status = "pending" → yellow
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId: tabSheetId, startRowIndex: 1, startColumnIndex: STATUS_COL, endColumnIndex: STATUS_COL + 1 }],
          booleanRule: {
            condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "pending" }] },
            format: { backgroundColor: yellow },
          },
        },
        index: 1,
      },
    },
    // status = "manual" → light gray
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId: tabSheetId, startRowIndex: 1, startColumnIndex: STATUS_COL, endColumnIndex: STATUS_COL + 1 }],
          booleanRule: {
            condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "manual" }] },
            format: { backgroundColor: lightGray },
          },
        },
        index: 2,
      },
    },
    // category is blank → light red (uncategorized flag)
    {
      addConditionalFormatRule: {
        rule: {
          ranges: [{ sheetId: tabSheetId, startRowIndex: 1, startColumnIndex: CATEGORY_COL, endColumnIndex: CATEGORY_COL + 1 }],
          booleanRule: {
            condition: { type: "BLANK" },
            format: { backgroundColor: lightRed },
          },
        },
        index: 3,
      },
    },
  ];

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests },
  });
  log("Conditional formatting: applied to Transactions tab (status + category columns)");
}

// ─── Step: Seed Budget Categories ─────────────────────────────────────────────
//
// Strategy: clear rows 2–501 and rewrite from categories.json on every run.
// Before clearing, we check for categories that existed in the sheet but were
// removed from categories.json. If any are referenced by transactions they are
// archived (active:false) rather than deleted — preserving historical data
// integrity. Categories with no transaction references are removed cleanly.

async function seedBudgetCategories(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  newCategories: FlatCategory[]
): Promise<void> {
  // ── 1. Read current Budget category rows to detect removals ──────────────────
  const existingRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `Budget!A${BUDGET_CATEGORIES_START_ROW}:G${BUDGET_CATEGORIES_END_ROW}`,
  });
  const existingRows = existingRes.data.values ?? [];

  // ── 2. Identify removed categories (in sheet now, absent from new JSON) ──────
  const newNames = new Set(newCategories.map((c) => c.category));
  const removedRows = existingRows.filter((r) => r[2] && !newNames.has(r[2]));

  // ── 3. Count transaction references for each removed category ────────────────
  //    Skip the Transactions read entirely if nothing was removed (common case).
  const txCounts = new Map<string, number>();
  if (removedRows.length > 0) {
    // Read only the category column (K) — avoids pulling full transaction rows.
    const txRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: "Transactions!K2:K",
    });
    for (const row of txRes.data.values ?? []) {
      const name = row[0] as string | undefined;
      if (name) txCounts.set(name, (txCounts.get(name) ?? 0) + 1);
    }
  }

  // ── 4. Decide archive vs remove for each removed category ────────────────────
  const toArchive: FlatCategory[] = [];
  for (const row of removedRows) {
    const name = row[2] as string;
    const txCount = txCounts.get(name) ?? 0;
    const { action, reason } = handleRemovedCategory(name, txCount);

    if (action === "archive") {
      toArchive.push({
        group: row[0] ?? "",
        subgroup: row[1] ?? "",
        category: name,
        type: row[3] ?? "fluid",
        template: parseFloat(row[4]) || 0,
        sort_order: parseInt(row[5]) || 9999,
        active: false,
      });
      log(`Budget seed: ⚠  archived "${name}" — ${reason}`);
    } else {
      log(`Budget seed: removed "${name}" — ${reason}`);
    }
  }

  // ── 5. Clear category rows and rewrite: active categories + archived ones ────
  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: `Budget!A${BUDGET_CATEGORIES_START_ROW}:G${BUDGET_CATEGORIES_END_ROW}`,
  });

  const allRows = [...newCategories, ...toArchive].map((c) => [
    c.group,
    c.subgroup,
    c.category,
    c.type,
    c.template,
    c.sort_order,
    c.active ? "TRUE" : "FALSE",
  ]);

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Budget!A${BUDGET_CATEGORIES_START_ROW}`,
    valueInputOption: "RAW",
    requestBody: { values: allRows },
  });

  const archivedCount = toArchive.length;
  const removedCount = removedRows.length - archivedCount;
  log(
    `Budget seed: wrote ${newCategories.length} active` +
    (archivedCount ? `, ${archivedCount} archived` : "") +
    (removedCount ? `, ${removedCount} removed` : "") +
    " categories"
  );
}

// ─── Step: Lock Budget category rows ─────────────────────────────────────────
//
// Protect rows 2–501 of the Budget tab with a warning. The edit path for
// categories is categories.json + re-run setup, not direct sheet editing.

async function lockBudgetCategories(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[]
): Promise<void> {
  const meta = findSheet(sheetMeta, "Budget");
  if (!meta) return;

  const tabSheetId = meta.properties?.sheetId!;

  // Check if a protection already covers the category rows range
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: "sheets(protectedRanges)",
  });

  const allProtected = spreadsheet.data.sheets?.flatMap(
    (s) => s.protectedRanges ?? []
  ) ?? [];

  // Row indices are 0-based: rows 7–506 → startRowIndex=6, endRowIndex=506
  const alreadyLocked = allProtected.some(
    (p) =>
      p.range?.sheetId === tabSheetId &&
      p.range?.startRowIndex === BUDGET_CATEGORIES_START_ROW - 1 &&
      p.range?.endRowIndex === BUDGET_CATEGORIES_END_ROW
  );

  if (alreadyLocked) {
    log(`Lock: Budget category rows already protected, skipping`);
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          addProtectedRange: {
            protectedRange: {
              range: {
                sheetId: tabSheetId,
                startRowIndex: BUDGET_CATEGORIES_START_ROW - 1,  // row 7 (0-based = 6)
                endRowIndex: BUDGET_CATEGORIES_END_ROW,           // row 506 inclusive
              },
              description: "Managed by categories.json — edit there and re-run setup, not here",
              warningOnly: true,
            },
          },
        },
      ],
    },
  });

  log(`Lock: Budget category rows ${BUDGET_CATEGORIES_START_ROW}–${BUDGET_CATEGORIES_END_ROW} protected (warn on edit)`);
}

// ─── Step: Lock BankToSheets-managed tabs ─────────────────────────────────────

async function lockBankToSheetsRaw(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[]
): Promise<void> {
  await lockTab(sheets, sheetId, sheetMeta, "Transactions (BTS)");
}

async function lockTab(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[],
  tabTitle: string
): Promise<void> {
  const meta = findSheet(sheetMeta, tabTitle);
  if (!meta) return;

  const tabSheetId = meta.properties?.sheetId!;

  // Check if already protected
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: "sheets(protectedRanges)",
  });

  const allProtected = spreadsheet.data.sheets?.flatMap(
    (s) => s.protectedRanges ?? []
  ) ?? [];

  const alreadyLocked = allProtected.some(
    (p) => p.range?.sheetId === tabSheetId
  );

  if (alreadyLocked) {
    log(`Lock: "${tabTitle}" already protected, skipping`);
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          addProtectedRange: {
            protectedRange: {
              range: { sheetId: tabSheetId },
              description: "Managed by BankToSheets integration — do not edit manually",
              warningOnly: true,
            },
          },
        },
      ],
    },
  });

  log(`Lock: "${tabTitle}" tab protected (warn on edit)`);
}

// ─── Step: Hide YNAB import tabs ─────────────────────────────────────────────

async function hideYnabTabs(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[]
): Promise<void> {
  const tabsToHide = ["YNAB_Plan_Import", "YNAB_Transactions_Import"];
  const requests: sheets_v4.Schema$Request[] = [];

  for (const title of tabsToHide) {
    const meta = findSheet(sheetMeta, title);
    if (!meta) continue;

    if (meta.properties?.hidden) {
      log(`Hide: ${title} already hidden, skipping`);
      continue;
    }

    requests.push({
      updateSheetProperties: {
        properties: { sheetId: meta.properties?.sheetId, hidden: true },
        fields: "hidden",
      },
    });
  }

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests },
    });
    log(`Hide: YNAB import tabs hidden`);
  }
}

// ─── Step: Write Budget Dashboard Header ──────────────────────────────────────
//
// Rows 1–5 of the Budget tab hold key/value pairs for the live dashboard.
// Column A = label, Column B = formula or value.
// Named ranges are created so the app and sheet formulas can reference by name.

async function writeBudgetDashboard(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[]
): Promise<void> {
  const meta = findSheet(sheetMeta, "Budget");
  if (!meta) return;

  // Check if dashboard is already written (B1 would have the formula)
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Budget!A1:B4",
  });

  if (existing.data.values?.[0]?.[0] === "ReadyToAssign") {
    log("Budget dashboard: already present, skipping");
    return;
  }

  // Assignment data starts one row after the header
  const dataStart = BUDGET_ASSIGNMENTS_START_ROW + 1;

  const dashboardRows = [
    [
      "ReadyToAssign",
      // inflow col Q, outflow col P; minus total assigned in assignments section
      `=SUM(Transactions!Q2:Q)-SUM(Transactions!P2:P)-SUM(Budget!C${dataStart}:C)`,
    ],
    ["LastYnabSync", ""],
    [
      "TotalAssignedThisMonth",
      `=SUMIF(Budget!A${dataStart}:A,TEXT(TODAY(),"yyyy-mm"),Budget!C${dataStart}:C)`,
    ],
    [
      "TotalAvailable",
      // Available = inflows − outflows − assigned (same as ReadyToAssign at this level)
      `=Budget!B1`,
    ],
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: "Budget!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: dashboardRows },
  });

  // Define named ranges pointing to the value cells (column B)
  const namedRanges = [
    { name: "ReadyToAssign", row: 1 },
    { name: "LastYnabSync", row: 2 },
    { name: "TotalAssignedThisMonth", row: 3 },
    { name: "TotalAvailable", row: 4 },
  ];

  // Fetch existing named ranges to avoid duplicates
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: "namedRanges",
  });
  const existingNames = new Set(
    (spreadsheet.data.namedRanges ?? []).map((nr) => nr.name)
  );

  const tabSheetId = meta.properties?.sheetId!;
  const requests: sheets_v4.Schema$Request[] = namedRanges
    .filter((nr) => !existingNames.has(nr.name))
    .map((nr) => ({
      addNamedRange: {
        namedRange: {
          name: nr.name,
          range: {
            sheetId: tabSheetId,
            startRowIndex: nr.row - 1,
            endRowIndex: nr.row,
            startColumnIndex: 1, // column B
            endColumnIndex: 2,
          },
        },
      },
    }));

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests },
    });
    log(`Budget dashboard: created ${requests.length} named range(s)`);
  }

  log("Budget dashboard: wrote rows 1–4 (ReadyToAssign, LastYnabSync, TotalAssignedThisMonth, TotalAvailable)");
}

// ─── Step: Write Budget_Calcs Formulas ────────────────────────────────────────
//
// Budget_Calcs holds one row per (month, category) pair.
// Each row has SUMIFS-based formulas for Activity and Assigned, and a
// rollover-aware Available formula that chains to the previous month's row.
// The tab is cleared and rewritten on every setup run so it stays in sync
// with any category changes and the rolling month window.

function generateMonthRange(monthsBack: number, monthsForward: number): string[] {
  const months: string[] = [];
  const now = new Date();
  const baseYear = now.getFullYear();
  const baseMonth = now.getMonth(); // 0-indexed

  for (let offset = -monthsBack; offset <= monthsForward; offset++) {
    const d = new Date(baseYear, baseMonth + offset, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

async function writeBudgetCalcs(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[],
  activeCategories: FlatCategory[]
): Promise<void> {
  const meta = findSheet(sheetMeta, "Budget_Calcs");
  if (!meta) {
    log("Budget_Calcs: tab not found, skipping");
    return;
  }

  const months = generateMonthRange(CALCS_MONTHS_BACK, CALCS_MONTHS_FORWARD);
  const cats = activeCategories.filter((c) => c.active).sort((a, b) => a.sort_order - b.sort_order);
  const N = cats.length; // rows per month block

  if (N === 0) {
    log("Budget_Calcs: no active categories, skipping formula rows");
    return;
  }

  // Row 1 = headers; data starts at row 2.
  const HEADER_ROW = 1;
  const DATA_START = HEADER_ROW + 1;

  // Ensure the grid is large enough before writing. New tabs default to 1000
  // rows which is often insufficient for months × categories.
  const requiredRows = DATA_START + months.length * N;
  const tabSheetId = meta.properties?.sheetId!;
  const currentRowCount = meta.properties?.gridProperties?.rowCount ?? 0;
  if (currentRowCount < requiredRows) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{
          updateSheetProperties: {
            properties: {
              sheetId: tabSheetId,
              gridProperties: { rowCount: requiredRows },
            },
            fields: "gridProperties.rowCount",
          },
        }],
      },
    });
    log(`Budget_Calcs: expanded grid to ${requiredRows} rows`);
  }

  // Always clear and rewrite so month window and categories stay current.
  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: "Budget_Calcs",
  });
  const assignDataStart = BUDGET_ASSIGNMENTS_START_ROW + 1; // 509

  // Build all formula rows. Row R for monthIdx m, catIdx c = DATA_START + m*N + c.
  const rows: (string | number)[][] = [];
  for (let m = 0; m < months.length; m++) {
    for (let c = 0; c < N; c++) {
      const R = DATA_START + m * N + c;
      const month = months[m];
      const catName = cats[c].category;

      // Activity: outflows minus inflows for this category+month, excluding
      // split child rows (parent_id non-empty) and transfer transactions.
      // SUMIFS with date range bounds is much faster than SUMPRODUCT+TEXT() array expansion.
      const monthStart = `DATEVALUE(A${R}&"-01")`;
      const monthEnd = `EDATE(${monthStart},1)`;
      const txBase = `Transactions!$K$2:$K$5000,B${R},Transactions!$H$2:$H$5000,">="&${monthStart},Transactions!$H$2:$H$5000,"<"&${monthEnd},Transactions!$B$2:$B$5000,"",Transactions!$T$2:$T$5000,"<>transfer"`;
      const activityFormula =
        `=SUMIFS(Transactions!$P$2:$P$5000,${txBase})` +
        `-SUMIFS(Transactions!$Q$2:$Q$5000,${txBase})`;

      // Assigned: sum of all assignment rows for this category+month.
      const assignedFormula =
        `=SUMIFS(Budget!$C$${assignDataStart}:$C$5000,Budget!$A$${assignDataStart}:$A$5000,A${R},Budget!$B$${assignDataStart}:$B$5000,B${R})`;

      // Available: previous month's available + this month's assigned − activity.
      // First month block has no prior row so rollover is 0.
      const availableFormula = m === 0
        ? `=D${R}-C${R}`
        : `=E${R - N}+D${R}-C${R}`;

      rows.push([month, catName, activityFormula, assignedFormula, availableFormula]);
    }
  }

  // Write header row
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: "Budget_Calcs!A1",
    valueInputOption: "RAW",
    requestBody: { values: [BUDGET_CALCS_COLUMNS] },
  });

  // Write formula rows in yearly chunks to stay well within API payload limits.
  const CHUNK_MONTHS = 12;
  const rowsPerChunk = CHUNK_MONTHS * N;
  for (let start = 0; start < rows.length; start += rowsPerChunk) {
    const chunk = rows.slice(start, start + rowsPerChunk);
    const startRow = DATA_START + start;
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `Budget_Calcs!A${startRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: chunk },
    });
  }

  // Freeze the header row.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId: tabSheetId,
              gridProperties: { frozenRowCount: 1 },
            },
            fields: "gridProperties.frozenRowCount",
          },
        },
        {
          repeatCell: {
            range: {
              sheetId: tabSheetId,
              startRowIndex: 0,
              endRowIndex: 1,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: HEADER_BG_COLOR,
                textFormat: { foregroundColor: HEADER_FG_COLOR, bold: true },
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat)",
          },
        },
      ],
    },
  });

  log(`Budget_Calcs: wrote ${rows.length} rows (${months.length} months × ${N} categories)`);
}

// ─── Step: Write Sheet Version ────────────────────────────────────────────────

async function writeSheetVersion(
  sheets: sheets_v4.Sheets,
  sheetId: string
): Promise<void> {
  // Store version in a dedicated cell on the Reflect tab (A1)
  // Using a named range "sheet_metadata" pointing to Reflect!A1
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Reflect!A1:B1",
  });

  if (existing.data.values?.[0]?.[0] === "sheet_version") {
    log(`Sheet version: already set to ${existing.data.values[0][1]}, skipping`);
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: "Reflect!A1",
    valueInputOption: "RAW",
    requestBody: { values: [["sheet_version", SHEET_VERSION]] },
  });

  log(`Sheet version: wrote SHEET_VERSION=${SHEET_VERSION} to Reflect!A1`);
}

// ─── Logging & Error Helpers ──────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function bail(msg: string): never {
  console.error(`\n  ✗ Error: ${msg}\n`);
  process.exit(1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n── Zero Budget Sheet Setup ─────────────────────────────────\n");

  // 1. Load environment
  const { sheetId, authConfig } = loadEnv();

  // 2. Validate categories
  const categoriesConfig = loadAndValidateCategories();
  const flatCategories = flattenCategories(categoriesConfig);

  // 3. Authenticate
  const auth = new google.auth.GoogleAuth({
    ...(authConfig.kind === "keyFile"
      ? { keyFile: authConfig.keyPath }
      : { credentials: authConfig.credentials }),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  log("Authenticated with Google Sheets API");

  // 4. Get current sheet state
  let sheetMeta = await getSheetMetadata(sheets, sheetId);
  log(`Found ${sheetMeta.length} existing tab(s)`);

  // 5. Ensure all tabs exist
  sheetMeta = await ensureTabsExist(sheets, sheetId, sheetMeta);

  // 6. Write headers + freeze + format
  await writeHeaders(sheets, sheetId, sheetMeta);

  // 7. Set column widths
  await setColumnWidths(sheets, sheetId, sheetMeta);

  // 8. Apply conditional formatting to Transactions
  await applyConditionalFormatting(sheets, sheetId, sheetMeta);

  // 9. Seed Budget tab with categories (clear-then-rewrite for clean sync)
  await seedBudgetCategories(sheets, sheetId, flatCategories);

  // 10. Lock Budget category rows + BankToSheets-managed tabs
  await lockBudgetCategories(sheets, sheetId, sheetMeta);
  await lockBankToSheetsRaw(sheets, sheetId, sheetMeta);
  await lockTab(sheets, sheetId, sheetMeta, "Balance History (BTS)");

  // 11. Hide YNAB import tabs
  await hideYnabTabs(sheets, sheetId, sheetMeta);

  // 12. Write Budget dashboard header (rows 1–5) with named ranges
  await writeBudgetDashboard(sheets, sheetId, sheetMeta);

  // 13. Write Budget_Calcs formulas (activity + available with rollover, per category per month)
  await writeBudgetCalcs(sheets, sheetId, sheetMeta, flatCategories);

  // 14. Write sheet version
  await writeSheetVersion(sheets, sheetId);

  console.log(
    "\n── Setup complete ───────────────────────────────────────────\n"
  );
}

main().catch((err) => {
  console.error("\n  ✗ Unexpected error:", err.message ?? err);
  process.exit(1);
});
