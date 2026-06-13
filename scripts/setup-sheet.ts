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
import { google, sheets_v4 } from "googleapis";

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

// Categories tab layout (new in v7):
//   Row 1:      Column headers (category_group, category_subgroup, ...)
//   Rows 2–506: Category data (500 rows reserved)
const CATEGORIES_START_ROW = 2;
const CATEGORIES_END_ROW = 506;

// Budget tab layout (new in v7 — assignments only):
//   Row 1:      Column headers (month, category, assigned, source, category_group)
//   Rows 2+:    Assignment data (grows indefinitely)
const BUDGET_ASSIGNMENTS_START_ROW = 1; // header row; data starts at row 2
const BUDGET_ASSIGNMENTS_COLUMNS = ["month", "category", "assigned", "source", "category_group"];

const GROUPS_COLUMNS = ["group_name", "budget_type", "rollover", "rollover_start_month", "monthly_template_amount"];

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

// Tabs visible to the user (human-managed or human-readable).
// Order here is the order they appear in the sheet tab bar.
const TABS_USER_FACING = [
  "Transactions",
  "Budget",
  "Categories",
  "Groups",
  "Split Rules",
  "Accounts",
  "Reflect",
];

// Tabs managed by scripts/BTS — hidden from the tab bar, never manually edited.
const TABS_PROCESS = [
  "Meta",           // app state + script config (replaces Dashboard + Config)
  "Budget_Log",
  "Budget_Calcs",
  "Transactions (BTS)",
  "Balance History (BTS)",
];

const TABS_IN_ORDER = [...TABS_USER_FACING, ...TABS_PROCESS];

const BUDGET_CALCS_COLUMNS = ["month", "category", "activity", "assigned", "available"];

// Accounts tab — two vertical sections separated by an empty column (col F).
// Section 1 (A–E): canonical account definitions.
// Section 2 (G–H): alias → canonical_name mapping for external import sources.
const ACCOUNTS_SECTION1_COLUMNS = ["canonical_name", "display_name", "type", "active", "display_order"];
const ACCOUNTS_SECTION2_COLUMNS = ["alias", "canonical_name"];
const ACCOUNTS_SECTION1_LABEL = "Accounts";
const ACCOUNTS_SECTION2_LABEL = "Account Aliases";
// Column indices (0-based) for the two section headers in row 1.
const ACCOUNTS_SECTION1_START_COL = 0; // col A
const ACCOUNTS_SECTION2_START_COL = 6; // col G (col F is empty separator)

// How many months back/forward from today to generate Budget_Calcs rows.
const CALCS_MONTHS_BACK = 36;
const CALCS_MONTHS_FORWARD = 24;

// Header background color (Google blue)
const HEADER_BG_COLOR = { red: 0.29, green: 0.525, blue: 0.91 };
const HEADER_FG_COLOR = { red: 1, green: 1, blue: 1 };

// Sheet schema version — increment when structure changes
// v8: gated formatting/validation steps behind version check (skip on already-current sheets);
//     formula version check in Budget_Calcs spot-check; open-ended column ranges.
// v9: Accounts tab with canonical account names, display names, types, and alias mapping;
//     account column validation on Transactions tab.
const SHEET_VERSION = 9;

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

  if (!["dev", "prod", "test"].includes(envName)) {
    bail(`Invalid --env value "${envName}". Use "dev", "prod", or "test".`);
  }

  const envFile =
    envName === "dev" ? ".env.development"
    : envName === "prod" ? ".env.production"
    : ".env.test";
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

// ─── Retry helper ─────────────────────────────────────────────────────────────
//
// Google Sheets API returns 503 (service unavailable) or 429 (rate limit) when
// the script makes too many calls in quick succession or when a large spreadsheet
// is busy computing formulas. Wrap every API call that can fail transiently.

function isRetryableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  // 503 = service unavailable (formula computation / quota burst)
  // 429 = too many requests
  // ECONNRESET / ETIMEDOUT = transient network blip
  return (
    msg.includes('503') ||
    msg.includes('The service is currently unavailable') ||
    msg.includes('429') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('aborted') ||
    msg.includes('The operation was aborted')
  );
}

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 5
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === maxAttempts || !isRetryableError(e)) throw e;
      const delay = Math.min(2 ** attempt * 1000, 30_000); // 2s, 4s, 8s, 16s, 30s cap
      console.log(`  ⟳ ${label}: transient error (attempt ${attempt}/${maxAttempts}), retrying in ${delay / 1000}s…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(`${label}: unreachable`);
}

// ─── Google Sheets Helpers ────────────────────────────────────────────────────

async function getSheetMetadata(
  sheets: sheets_v4.Sheets,
  sheetId: string
): Promise<sheets_v4.Schema$Sheet[]> {
  const res = await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: "sheets(properties(sheetId,title,hidden,gridProperties))",
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

// Explicit initial grid sizes for tabs that don't need the default 1000×26.
// Google Sheets enforces a 10M-cell workbook limit — keeping small tabs small
// avoids hitting that ceiling when the sheet has many existing tabs.
const TAB_GRID_SIZES: Record<string, { rowCount: number; columnCount: number }> = {
  "Accounts":         { rowCount: 500,  columnCount: 9  }, // ~4,500 cells
  "Groups":           { rowCount: 200,  columnCount: 6  }, // ~1,200 cells
  "Split Rules":      { rowCount: 500,  columnCount: 11 }, // ~5,500 cells
  "Budget_Log":       { rowCount: 5000, columnCount: 7  }, // ~35,000 cells
};

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

  const requests: sheets_v4.Schema$Request[] = toCreate.map((title) => {
    const gridProperties = TAB_GRID_SIZES[title];
    return {
      addSheet: {
        properties: {
          title,
          ...(gridProperties ? { gridProperties } : {}),
        },
      },
    };
  });

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
  // All tabs below use row 1 as their header row.
  const tabHeaders: Array<{ title: string; columns: string[] }> = [
    { title: "Transactions", columns: TRANSACTIONS_COLUMNS },
    { title: "Budget", columns: BUDGET_ASSIGNMENTS_COLUMNS },
    { title: "Categories", columns: BUDGET_CATEGORY_COLUMNS },
    { title: "Groups", columns: GROUPS_COLUMNS },
    { title: "Split Rules", columns: TEMPLATES_COLUMNS },
    { title: "Budget_Log", columns: BUDGET_LOG_COLUMNS },
  ];

  const formatRequests: sheets_v4.Schema$Request[] = [];

  for (const { title, columns } of tabHeaders) {
    const meta = findSheet(sheetMeta, title);
    if (!meta) continue;

    const tabSheetId = meta.properties?.sheetId!;

    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${title}!1:1`,
    });

    const currentValues = existing.data.values?.[0] ?? [];

    // Compare actual content against the expected column names — not just presence.
    const headersCorrect =
      currentValues.length >= columns.length &&
      columns.every((col, i) => currentValues[i]?.trim() === col.trim());

    if (headersCorrect) {
      log(`Headers: ${title} row 1 already correct, skipping`);
    } else {
      if (currentValues.length > 0) {
        log(`Headers: ${title} row 1 has stale/incorrect content — overwriting with column headers`);
      }
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${title}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [columns] },
      });
      log(`Headers: wrote ${columns.length} columns to ${title} row 1`);
    }

    // Format header row: bold, background color, freeze row 1
    formatRequests.push(
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
            gridProperties: { frozenRowCount: 1 },
          },
          fields: "gridProperties.frozenRowCount",
        },
      }
    );
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

  // Skip if rules already exist on the Transactions tab (re-run guard).
  // Each run would otherwise append duplicate rules — this just checks for any existing rule.
  const txSheet = (await sheets.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: "sheets(properties(sheetId),conditionalFormats)",
  })).data.sheets?.find((s) => s.properties?.sheetId === tabSheetId);
  if ((txSheet?.conditionalFormats ?? []).length > 0) {
    log("Conditional formatting: rules already present, skipping");
    return;
  }

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
  // NOTE: We intentionally do NOT add a CUSTOM_FORMULA rule here for
  // "category value not in Categories list → orange". The Sheets API v4 rejects
  // cross-sheet references (e.g. Categories!$C$2:$C$2000) inside CUSTOM_FORMULA
  // conditions, even though the Sheets UI allows them. The data validation rule
  // added by addCategoryDataValidation() already shows a warning indicator on
  // cells with unknown category values, which is sufficient visual feedback.
  log("Conditional formatting: applied to Transactions tab (status + category columns)");
}

// ─── Step: Category data validation ──────────────────────────────────────────

/**
 * Add a dropdown data validation to the category column in the Transactions tab.
 * Source: Categories!$C$2:$C$2000 (the canonical category name list).
 * Mode: SHOW_WARNING (non-strict) — existing transactions with blank or custom
 * categories won't be rejected, but invalid values show a warning indicator.
 */
async function addCategoryDataValidation(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[]
): Promise<void> {
  const txMeta = findSheet(sheetMeta, "Transactions");
  if (!txMeta) return;

  const tabSheetId = txMeta.properties?.sheetId!;
  const CATEGORY_COL = TRANSACTIONS_COLUMNS.indexOf("category");

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          setDataValidation: {
            range: {
              sheetId: tabSheetId,
              startRowIndex: 1,       // row 2 (0-based) — skip header
              startColumnIndex: CATEGORY_COL,
              endColumnIndex: CATEGORY_COL + 1,
            },
            rule: {
              condition: {
                type: "ONE_OF_RANGE",
                values: [{ userEnteredValue: "=Categories!$C$2:$C$2000" }],
              },
              showCustomUi: true,     // show dropdown picker
              strict: false,          // SHOW_WARNING — don't reject, just flag
            },
          },
        },
      ],
    },
  });
  log("Data validation: category dropdown applied to Transactions tab (Categories!C2:C2000)");
}



// ─── Step: Accounts tab ───────────────────────────────────────────────────────
//
// Layout (two vertical sections, col F is an empty separator):
//   Row 1: Merged section header "Accounts" (A1:E1), merged "Account Aliases" (G1:H1)
//   Row 2: Column sub-headers for each section
//   Row 3+: Data rows (seeded on first run from distinct Transactions!account values)

async function setupAccountsTab(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[]
): Promise<void> {
  const meta = findSheet(sheetMeta, "Accounts");
  if (!meta) return;
  const tabSheetId = meta.properties?.sheetId!;

  // ── Row 1: section header labels (merged cells) ──────────────────────────
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: "Accounts!A1",
    valueInputOption: "RAW",
    requestBody: { values: [[ACCOUNTS_SECTION1_LABEL]] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: "Accounts!G1",
    valueInputOption: "RAW",
    requestBody: { values: [[ACCOUNTS_SECTION2_LABEL]] },
  });

  // ── Row 2: column sub-headers ────────────────────────────────────────────
  const row2: string[] = [
    ...ACCOUNTS_SECTION1_COLUMNS,
    "",  // col F — empty separator
    ...ACCOUNTS_SECTION2_COLUMNS,
  ];
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: "Accounts!A2",
    valueInputOption: "RAW",
    requestBody: { values: [row2] },
  });

  // ── Formatting: merge row 1 headers, bold row 2, freeze row 2 ────────────
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        // Merge "Accounts" header across A1:E1
        {
          mergeCells: {
            range: {
              sheetId: tabSheetId,
              startRowIndex: 0, endRowIndex: 1,
              startColumnIndex: ACCOUNTS_SECTION1_START_COL,
              endColumnIndex: ACCOUNTS_SECTION1_START_COL + ACCOUNTS_SECTION1_COLUMNS.length,
            },
            mergeType: "MERGE_ALL",
          },
        },
        // Merge "Account Aliases" header across G1:H1
        {
          mergeCells: {
            range: {
              sheetId: tabSheetId,
              startRowIndex: 0, endRowIndex: 1,
              startColumnIndex: ACCOUNTS_SECTION2_START_COL,
              endColumnIndex: ACCOUNTS_SECTION2_START_COL + ACCOUNTS_SECTION2_COLUMNS.length,
            },
            mergeType: "MERGE_ALL",
          },
        },
        // Format row 1 (section headers): bold, centered, blue background
        {
          repeatCell: {
            range: { sheetId: tabSheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: HEADER_BG_COLOR,
                textFormat: { foregroundColor: HEADER_FG_COLOR, bold: true, fontSize: 11 },
                horizontalAlignment: "CENTER",
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
          },
        },
        // Format row 2 (column sub-headers): bold, lighter blue background
        {
          repeatCell: {
            range: { sheetId: tabSheetId, startRowIndex: 1, endRowIndex: 2 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.78, green: 0.85, blue: 0.97 },
                textFormat: { bold: true },
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat)",
          },
        },
        // Freeze first two rows
        {
          updateSheetProperties: {
            properties: { sheetId: tabSheetId, gridProperties: { frozenRowCount: 2 } },
            fields: "gridProperties.frozenRowCount",
          },
        },
        // active column (D, index 3) → BOOLEAN checkbox, data rows only (row 3+)
        {
          setDataValidation: {
            range: {
              sheetId: tabSheetId,
              startRowIndex: 2,
              startColumnIndex: ACCOUNTS_SECTION1_COLUMNS.indexOf("active"),
              endColumnIndex: ACCOUNTS_SECTION1_COLUMNS.indexOf("active") + 1,
            },
            rule: {
              condition: { type: "BOOLEAN" },
              showCustomUi: true,
              strict: true,
            },
          },
        },
      ],
    },
  });

  log("Accounts tab: headers and formatting applied");

  // ── Seed canonical_name from Transactions!account on first run ────────────
  // Check if any data rows exist (row 3+)
  const existingData = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Accounts!A3:A",
  });
  const hasData = (existingData.data.values?.length ?? 0) > 0;

  if (hasData) {
    log("Accounts tab: data rows already present, skipping seed");
    return;
  }

  // Read distinct account values from Transactions tab
  const txAccountRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Transactions!R2:R",  // column R = account
  });
  const allAccountValues = txAccountRes.data.values?.flat() ?? [];
  const distinctAccounts = [...new Set(allAccountValues.filter(Boolean))].sort();

  if (distinctAccounts.length === 0) {
    log("Accounts tab: no existing transactions found — tab left empty for manual entry");
    return;
  }

  // Write one row per distinct account: canonical_name | display_name (blank) | type (blank) | active=TRUE | display_order
  const seedRows = distinctAccounts.map((name, i) => [
    name,   // canonical_name
    "",     // display_name (user fills in)
    "",     // type (user fills in: depository/credit/etc)
    true,   // active
    i + 1,  // display_order
  ]);

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: "Accounts!A3",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: seedRows },
  });

  log(`Accounts tab: seeded ${seedRows.length} account(s) from Transactions history`);
}

// ─── Step: Account validation on Transactions tab ────────────────────────────

async function addAccountValidation(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[]
): Promise<void> {
  const txMeta = findSheet(sheetMeta, "Transactions");
  if (!txMeta) return;

  const ACCOUNT_COL = TRANSACTIONS_COLUMNS.indexOf("account");

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          setDataValidation: {
            range: {
              sheetId: txMeta.properties?.sheetId!,
              startRowIndex: 1,
              startColumnIndex: ACCOUNT_COL,
              endColumnIndex: ACCOUNT_COL + 1,
            },
            rule: {
              condition: {
                type: "ONE_OF_RANGE",
                // Validate against the canonical_name column (A) in Accounts, data rows only (3+)
                values: [{ userEnteredValue: "=Accounts!$A$3:$A$1000" }],
              },
              showCustomUi: true,
              strict: false, // SHOW_WARNING — flag unrecognized accounts without hard-rejecting
            },
          },
        },
      ],
    },
  });
  log("Data validation: account dropdown applied to Transactions tab (Accounts!A3:A1000)");
}

// ─── Step: Additional data validations ───────────────────────────────────────
//
// Beyond the category dropdown on Transactions (addCategoryDataValidation above),
// we apply:
//   • reviewed column   → BOOLEAN checkbox
//   • transaction_type  → ONE_OF_LIST (system-managed enum)
//   • Budget category   → ONE_OF_RANGE from Categories list
//   • Categories category_group → ONE_OF_RANGE from Groups list
//   • Categories category_type  → ONE_OF_LIST (system-managed enum)

async function addAdditionalValidations(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[]
): Promise<void> {
  const txMeta   = findSheet(sheetMeta, "Transactions");
  const budgetMeta = findSheet(sheetMeta, "Budget");
  const catMeta  = findSheet(sheetMeta, "Categories");

  const requests: sheets_v4.Schema$Request[] = [];

  // ── Transactions: reviewed column → checkbox ─────────────────────────────
  if (txMeta) {
    const REVIEWED_COL = TRANSACTIONS_COLUMNS.indexOf("reviewed");
    requests.push({
      setDataValidation: {
        range: {
          sheetId: txMeta.properties?.sheetId!,
          startRowIndex: 1,
          startColumnIndex: REVIEWED_COL,
          endColumnIndex: REVIEWED_COL + 1,
        },
        rule: {
          condition: { type: "BOOLEAN" },
          showCustomUi: true,
          strict: true,
        },
      },
    });
  }

  // ── Transactions: transaction_type → ONE_OF_LIST ──────────────────────────
  if (txMeta) {
    const TX_TYPE_COL = TRANSACTIONS_COLUMNS.indexOf("transaction_type");
    requests.push({
      setDataValidation: {
        range: {
          sheetId: txMeta.properties?.sheetId!,
          startRowIndex: 1,
          startColumnIndex: TX_TYPE_COL,
          endColumnIndex: TX_TYPE_COL + 1,
        },
        rule: {
          condition: {
            type: "ONE_OF_LIST",
            values: [
              { userEnteredValue: "regular" },
              { userEnteredValue: "transfer" },
              { userEnteredValue: "credit_payment" },
              { userEnteredValue: "split_parent" },
              { userEnteredValue: "split_child" },
              { userEnteredValue: "income" },
            ],
          },
          showCustomUi: true,
          strict: false, // warn only — existing legacy values (debit/credit) shouldn't error
        },
      },
    });
  }

  // ── Budget: category column → ONE_OF_RANGE from Categories ───────────────
  if (budgetMeta) {
    const BUDGET_CAT_COL = BUDGET_ASSIGNMENTS_COLUMNS.indexOf("category");
    requests.push({
      setDataValidation: {
        range: {
          sheetId: budgetMeta.properties?.sheetId!,
          startRowIndex: 1,
          startColumnIndex: BUDGET_CAT_COL,
          endColumnIndex: BUDGET_CAT_COL + 1,
        },
        rule: {
          condition: {
            type: "ONE_OF_RANGE",
            values: [{ userEnteredValue: "=Categories!$C$2:$C$2000" }],
          },
          showCustomUi: true,
          strict: false,
        },
      },
    });
  }

  // ── Categories: category_group → ONE_OF_RANGE from Groups ────────────────
  if (catMeta) {
    const CAT_GROUP_COL = BUDGET_CATEGORY_COLUMNS.indexOf("category_group");
    requests.push({
      setDataValidation: {
        range: {
          sheetId: catMeta.properties?.sheetId!,
          startRowIndex: 1,
          startColumnIndex: CAT_GROUP_COL,
          endColumnIndex: CAT_GROUP_COL + 1,
        },
        rule: {
          condition: {
            type: "ONE_OF_RANGE",
            values: [{ userEnteredValue: "=Groups!$A$2:$A$500" }],
          },
          showCustomUi: true,
          strict: false,
        },
      },
    });
  }

  // ── Categories: category_type → ONE_OF_LIST ───────────────────────────────
  // These are the system-managed budget behaviour types used in all calcs.
  if (catMeta) {
    const CAT_TYPE_COL = BUDGET_CATEGORY_COLUMNS.indexOf("category_type");
    requests.push({
      setDataValidation: {
        range: {
          sheetId: catMeta.properties?.sheetId!,
          startRowIndex: 1,
          startColumnIndex: CAT_TYPE_COL,
          endColumnIndex: CAT_TYPE_COL + 1,
        },
        rule: {
          condition: {
            type: "ONE_OF_LIST",
            values: [
              { userEnteredValue: "fluid" },
              { userEnteredValue: "savings_target" },
              { userEnteredValue: "fixed_bill" },
            ],
          },
          showCustomUi: true,
          strict: false,
        },
      },
    });
  }

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests },
    });
    log("Data validation: reviewed checkbox, transaction_type list, Budget category, Categories group + type");
  }
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

// ─── Step: Migrate legacy tab names ──────────────────────────────────────────

/**
 * Rename legacy tabs that have been retired or renamed.
 * Safe to run repeatedly — skips tabs that are already renamed or don't exist.
 *
 * Renames / deletions:
 *   "Templates"        → "Split Rules"   (clearer name; "Apply Template" button is unrelated)
 *   "Dashboard"        → "Meta"          (merged with Config; no longer a view tab)
 *   "Config"           → deleted         (key-value config now lives in Meta rows 6+)
 *   "YNAB_Plan_Import" → deleted         (retired; import always reads local CSV now)
 *   "YNAB_Transactions_Import" → deleted (was always empty/reserved)
 */
async function migrateLegacyTabs(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[]
): Promise<void> {
  const requests: sheets_v4.Schema$Request[] = [];

  // Rename "Templates" → "Split Rules"
  const oldTemplates = findSheet(sheetMeta, "Templates");
  const newSplitRules = findSheet(sheetMeta, "Split Rules");
  if (oldTemplates && !newSplitRules) {
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: oldTemplates.properties?.sheetId, title: "Split Rules" },
        fields: "title",
      },
    });
    log('Migrate: renamed "Templates" → "Split Rules"');
  }

  // Rename "Dashboard" → "Meta" (Config data will be appended by writeMetaTab)
  const oldDashboard = findSheet(sheetMeta, "Dashboard");
  const newMeta = findSheet(sheetMeta, "Meta");
  if (oldDashboard && !newMeta) {
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: oldDashboard.properties?.sheetId, title: "Meta" },
        fields: "title",
      },
    });
    log('Migrate: renamed "Dashboard" → "Meta"');
  }

  // Delete retired tabs
  for (const title of ["Config", "YNAB_Plan_Import", "YNAB_Transactions_Import"]) {
    const meta = findSheet(sheetMeta, title);
    if (meta) {
      requests.push({ deleteSheet: { sheetId: meta.properties?.sheetId } });
      log(`Migrate: deleted retired tab "${title}"`);
    }
  }

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests },
    });
  }
}

// ─── Step: Write Meta tab ─────────────────────────────────────────────────────
//
// Meta tab layout (replaces Dashboard + Config):
//   Row 1:    headers — key | value
//   Row 2:    ReadyToAssign   | live formula
//   Row 3:    LastYnabSync    | timestamp (written by import scripts)
//   Row 4:    TotalAssignedThisMonth | live formula
//   Row 5:    TotalAvailable  | live formula
//   Rows 6+:  script config key-value pairs (e.g. live_sync_from_date)
//
// Named ranges point to column B of rows 2–5 so the app and formulas can
// reference values by name without caring about row numbers.
//
// upsertConfigValue lives in config-tab.ts (imported here and re-exported so
// callers don't need to import setup-sheet.ts, which has an unguarded main()).

export { upsertConfigValue } from "./config-tab";

async function writeMetaTab(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[]
): Promise<void> {
  const meta = findSheet(sheetMeta, "Meta");
  if (!meta) return;

  // Check if Meta tab already has the expected header + dashboard rows.
  // Read column A only — column B contains live SUM/SUMIF formulas that Google
  // Sheets evaluates before returning, which blocks for several minutes on large
  // Transactions datasets. The key labels in column A are plain text; reading
  // them is instant.
  const existing = await withRetry("Meta: read labels", () =>
    sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: "Meta!A1:A5",
    })
  );
  const rows = existing.data.values ?? [];
  const hasHeader = rows[0]?.[0] === "key";
  const hasReadyToAssign = rows[1]?.[0] === "ReadyToAssign";

  if (hasHeader && hasReadyToAssign) {
    log("Meta: header + dashboard rows already present, skipping write");
    log("Meta: ensuring named ranges...");
    await ensureMetaNamedRanges(sheets, sheetId, meta.properties?.sheetId!);
    return;
  }

  const dataStart = BUDGET_ASSIGNMENTS_START_ROW + 1; // 2

  const metaRows = [
    ["key", "value"],
    [
      "ReadyToAssign",
      `=SUM(Transactions!Q2:Q)-SUM(Transactions!P2:P)-SUM(Budget!C${dataStart}:C)`,
    ],
    ["LastYnabSync", ""],
    [
      "TotalAssignedThisMonth",
      `=SUMIF(Budget!A${dataStart}:A,TEXT(TODAY(),"yyyy-mm"),Budget!C${dataStart}:C)`,
    ],
    ["TotalAvailable", `=Meta!B2`],
  ];

  await withRetry("Meta: write rows", () =>
    sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: "Meta!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: metaRows },
    })
  );

  await ensureMetaNamedRanges(sheets, sheetId, meta.properties?.sheetId!);

  log("Meta: wrote header row + dashboard rows 2–5 (ReadyToAssign, LastYnabSync, TotalAssignedThisMonth, TotalAvailable)");
}

/**
 * Create or update named ranges pointing to Meta!B2:B5.
 * Always upserts — safe to call on re-runs and after Dashboard→Meta rename.
 */
async function ensureMetaNamedRanges(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  metaTabSheetId: number
): Promise<void> {
  // Row indices are 0-based. Dashboard rows are at sheet rows 2–5 (1-based),
  // which are indices 1–4. Column B = index 1.
  const namedRanges = [
    { name: "ReadyToAssign",         rowIndex: 1 },
    { name: "LastYnabSync",          rowIndex: 2 },
    { name: "TotalAssignedThisMonth", rowIndex: 3 },
    { name: "TotalAvailable",        rowIndex: 4 },
  ];

  log("Meta: reading existing named ranges...");
  const spreadsheet = await withRetry("Meta: read named ranges", () =>
    sheets.spreadsheets.get({
      spreadsheetId: sheetId,
      fields: "namedRanges",
    })
  );
  const existingByName = new Map(
    (spreadsheet.data.namedRanges ?? []).map((nr) => [nr.name!, nr])
  );

  // Skip the batchUpdate if all 4 named ranges already point to the right cells.
  const allCorrect = namedRanges.every((nr) => {
    const ex = existingByName.get(nr.name);
    if (!ex) return false;
    const r = ex.range;
    return (
      r?.sheetId === metaTabSheetId &&
      r?.startRowIndex === nr.rowIndex &&
      r?.endRowIndex === nr.rowIndex + 1 &&
      r?.startColumnIndex === 1 &&
      r?.endColumnIndex === 2
    );
  });
  if (allCorrect) {
    log("Meta: named ranges already correct, skipping update");
    return;
  }

  const requests: sheets_v4.Schema$Request[] = namedRanges.map((nr) => {
    const rangeSpec = {
      sheetId: metaTabSheetId,
      startRowIndex: nr.rowIndex,
      endRowIndex: nr.rowIndex + 1,
      startColumnIndex: 1, // column B
      endColumnIndex: 2,
    };
    const existing = existingByName.get(nr.name);
    if (existing) {
      return {
        updateNamedRange: {
          namedRange: {
            namedRangeId: existing.namedRangeId,
            name: nr.name,
            range: rangeSpec,
          },
          fields: "range",
        },
      };
    }
    return {
      addNamedRange: {
        namedRange: { name: nr.name, range: rangeSpec },
      },
    };
  });

  log("Meta: writing named ranges...");
  await withRetry("Meta: write named ranges", () =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests },
    })
  );
  log("Meta: named ranges upserted (ReadyToAssign, LastYnabSync, TotalAssignedThisMonth, TotalAvailable → Meta!B2:B5)");
}

// ─── Step: Hide process-managed tabs ─────────────────────────────────────────
//
// Process tabs (Meta, Budget_Log, Budget_Calcs, BTS tabs) are hidden from the
// tab bar. They are still fully accessible by scripts and formulas — just not
// cluttering the user's view. Users who need to inspect them can unhide via
// View → Hidden sheets.

async function hideProcessTabs(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[]
): Promise<void> {
  const requests: sheets_v4.Schema$Request[] = [];
  const toHide: string[] = [];

  for (const title of TABS_PROCESS) {
    const meta = findSheet(sheetMeta, title);
    if (!meta) continue;
    if (meta.properties?.hidden) continue; // already hidden

    requests.push({
      updateSheetProperties: {
        properties: { sheetId: meta.properties?.sheetId, hidden: true },
        fields: "hidden",
      },
    });
    toHide.push(title);
  }

  if (requests.length === 0) {
    log("Hide process tabs: all already hidden");
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { requests },
  });
  log(`Hide process tabs: hid ${toHide.length} tab(s): ${toHide.join(", ")}`);
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
  sheetMeta: sheets_v4.Schema$Sheet[]
): Promise<void> {
  const meta = findSheet(sheetMeta, "Budget_Calcs");
  if (!meta) {
    log("Budget_Calcs: tab not found, skipping");
    return;
  }

  // Read active categories from the user-managed Categories tab.
  // Columns: category_group(0), subgroup(1), category(2), type(3), template(4), sort_order(5), active(6)
  const catRes = await withRetry("Budget_Calcs: read categories", () =>
    sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `Categories!A${CATEGORIES_START_ROW}:G${CATEGORIES_END_ROW}`,
    })
  );
  const cats = (catRes.data.values ?? [])
    .filter((r) => r[2] && (r[6] ?? "").toString().toUpperCase() === "TRUE")
    .map((r) => ({ category: r[2] as string, sort_order: parseInt(r[5] ?? "0") || 0 }))
    .sort((a, b) => a.sort_order - b.sort_order);

  const months = generateMonthRange(CALCS_MONTHS_BACK, CALCS_MONTHS_FORWARD);
  const N = cats.length; // rows per month block

  if (N === 0) {
    log("Budget_Calcs: Categories tab is empty, skipping formula rows");
    return;
  }

  // Row 1 = headers; data starts at row 2.
  const HEADER_ROW = 1;
  const DATA_START = HEADER_ROW + 1;

  // ── Skip check ────────────────────────────────────────────────────────────
  // Rewriting 60+ months × 100 categories is expensive. Skip it if the tab
  // already has the right shape: grid is large enough AND the first/last month
  // cells match what we'd write. Categories changing or the month window
  // rolling past an edge will both trigger a rewrite.
  const requiredRows = DATA_START + months.length * N; // e.g. 2 + 6161 = 6163
  const currentRowCount = meta.properties?.gridProperties?.rowCount ?? 0;
  if (currentRowCount >= requiredRows) {
    // Spot-check first data row (month + category) and last data row (month).
    const lastDataRow = DATA_START + months.length * N - 1;
    const spotCheck = await withRetry("Budget_Calcs: spot-check", () =>
      sheets.spreadsheets.values.batchGet({
        spreadsheetId: sheetId,
        // FORMULA render option: plain-text cells (month, category) return
        // unchanged; formula cells return the formula string so we can detect
        // outdated patterns (e.g. old $5000 row cap).
        valueRenderOption: "FORMULA",
        ranges: [
          `Budget_Calcs!A${DATA_START}:C${DATA_START}`,
          `Budget_Calcs!A${lastDataRow}`,
        ],
      })
    );
    const firstRow = spotCheck.data.valueRanges?.[0]?.values?.[0] ?? [];
    const lastRow  = spotCheck.data.valueRanges?.[1]?.values?.[0] ?? [];
    const firstMonthOk  = firstRow[0] === months[0];
    const firstCatOk    = firstRow[1] === cats[0].category;
    const lastMonthOk   = lastRow[0]  === months[months.length - 1];
    // Check that the activity formula doesn't use the old hardcoded $5000 row cap.
    const activityFx    = String(firstRow[2] ?? "");
    const formulasOk    = activityFx.length > 0 && !activityFx.includes("$5000");
    if (firstMonthOk && firstCatOk && lastMonthOk && formulasOk) {
      log(`Budget_Calcs: already up to date (${months.length} months × ${N} categories, rows ${DATA_START}–${lastDataRow}), skipping rewrite`);
      return;
    }
    // Log which check(s) failed to make future debugging easier.
    const reasons: string[] = [];
    if (!firstMonthOk)  reasons.push(`firstMonth: sheet="${firstRow[0]}" expected="${months[0]}"`);
    if (!firstCatOk)    reasons.push(`firstCat: sheet="${firstRow[1]}" expected="${cats[0].category}"`);
    if (!lastMonthOk)   reasons.push(`lastMonth (row ${lastDataRow}): sheet="${lastRow[0]}" expected="${months[months.length - 1]}"`);
    if (!formulasOk)    reasons.push(`formula outdated (old $5000 cap or empty)`);
    log(`Budget_Calcs: rewriting — ${reasons.join("; ")}`);
  }

  // Ensure the grid is large enough before writing. New tabs default to 1000
  // rows which is often insufficient for months × categories.
  const tabSheetId = meta.properties?.sheetId!;
  if (currentRowCount < requiredRows) {
    await withRetry("Budget_Calcs: expand grid", () =>
      sheets.spreadsheets.batchUpdate({
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
      })
    );
    log(`Budget_Calcs: expanded grid to ${requiredRows} rows`);
  }

  // Clear and rewrite. Each operation is wrapped individually so a transient
  // error mid-write is retried in place rather than restarting from the clear.
  await withRetry("Budget_Calcs: clear", () =>
    sheets.spreadsheets.values.clear({
      spreadsheetId: sheetId,
      range: "Budget_Calcs",
    })
  );
  const assignDataStart = BUDGET_ASSIGNMENTS_START_ROW + 1; // 2

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
      // Open-ended column ranges (no row cap) so formulas automatically cover
      // all current and future rows. Google Sheets handles unbounded SUMIFS
      // efficiently — it does not scan blank rows once data ends.
      const txBase = `Transactions!$K$2:$K,B${R},Transactions!$H$2:$H,">="&${monthStart},Transactions!$H$2:$H,"<"&${monthEnd},Transactions!$B$2:$B,"",Transactions!$T$2:$T,"<>transfer"`;
      const activityFormula =
        `=SUMIFS(Transactions!$P$2:$P,${txBase})` +
        `-SUMIFS(Transactions!$Q$2:$Q,${txBase})`;

      // Assigned: sum of all assignment rows for this category+month.
      const assignedFormula =
        `=SUMIFS(Budget!$C$${assignDataStart}:$C,Budget!$A$${assignDataStart}:$A,A${R},Budget!$B$${assignDataStart}:$B,B${R})`;

      // Available: previous month's available + this month's assigned − activity.
      // First month block has no prior row so rollover is 0.
      const availableFormula = m === 0
        ? `=D${R}-C${R}`
        : `=E${R - N}+D${R}-C${R}`;

      rows.push([month, catName, activityFormula, assignedFormula, availableFormula]);
    }
  }

  // Write header row
  await withRetry("Budget_Calcs: write header", () =>
    sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: "Budget_Calcs!A1",
      valueInputOption: "RAW",
      requestBody: { values: [BUDGET_CALCS_COLUMNS] },
    })
  );

  // Write formula rows in yearly chunks to stay well within API payload limits.
  // Each chunk is individually retried so an abort mid-write doesn't restart
  // the entire clear+write sequence.
  //
  // Columns A:B (month, category) are plain text — written with RAW so Google
  // Sheets does NOT interpret "2023-06" as a date serial. Columns C:E are
  // formulas — written with USER_ENTERED so Sheets evaluates them.
  const CHUNK_MONTHS = 12;
  const rowsPerChunk = CHUNK_MONTHS * N;
  for (let start = 0; start < rows.length; start += rowsPerChunk) {
    const chunk = rows.slice(start, start + rowsPerChunk);
    const startRow = DATA_START + start;
    const endRow = startRow + chunk.length - 1;

    // Pass 1: month + category as raw text (A:B)
    await withRetry(`Budget_Calcs: write text chunk @ row ${startRow}`, () =>
      sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `Budget_Calcs!A${startRow}:B${endRow}`,
        valueInputOption: "RAW",
        requestBody: { values: chunk.map((r) => [r[0], r[1]]) },
      })
    );

    // Pass 2: formulas (C:E) — must be USER_ENTERED so Sheets parses "=..."
    await withRetry(`Budget_Calcs: write formula chunk @ row ${startRow}`, () =>
      sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `Budget_Calcs!C${startRow}:E${endRow}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: chunk.map((r) => [r[2], r[3], r[4]]) },
      })
    );
  }

  // Freeze the header row.
  await withRetry("Budget_Calcs: freeze header", () => sheets.spreadsheets.batchUpdate({
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
  }));

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

  const existingVersion = Number(existing.data.values?.[0]?.[1] ?? 0);
  if (existing.data.values?.[0]?.[0] === "sheet_version" && existingVersion === SHEET_VERSION) {
    log(`Sheet version: already at ${SHEET_VERSION}, skipping`);
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

// ─── Step: Clean Up Orphaned Assignment Rows ──────────────────────────────────

const YYYYMM_RE = /^\d{4}-\d{2}$/;

/**
 * Remove any Budget assignment rows where the month cell is not in YYYY-MM
 * format. This cleans up rows written before the USER_ENTERED → RAW fix, where
 * Google Sheets silently converted "2026-05" to a date serial (e.g. 46143).
 * Deletion is done via batchUpdate deleteRange requests, which physically
 * removes the rows and shifts remaining data up.
 */
async function cleanOrphanedAssignmentRows(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[]
): Promise<void> {
  const dataStart = BUDGET_ASSIGNMENTS_START_ROW + 1; // 2

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `Budget!A${dataStart}:A`,
  });

  const rows = res.data.values ?? [];
  if (rows.length === 0) {
    log("Cleanup: no assignment data rows found, skipping");
    return;
  }

  // Collect 0-based sheet row indices of orphaned rows (descending so we can
  // delete bottom-up without shifting indices of earlier rows).
  const orphanedIndices: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cell = (rows[i]?.[0] ?? "").toString().trim();
    if (cell !== "" && !YYYYMM_RE.test(cell)) {
      orphanedIndices.push(dataStart - 1 + i); // convert to 0-based sheet row index
    }
  }

  if (orphanedIndices.length === 0) {
    log("Cleanup: no orphaned assignment rows found");
    return;
  }

  log(`Cleanup: found ${orphanedIndices.length} orphaned assignment row(s) with invalid month values`);

  const budgetMeta = findSheet(sheetMeta, "Budget");
  if (!budgetMeta) {
    log("Cleanup: Budget sheet metadata not found, skipping deletion");
    return;
  }
  const tabSheetId = budgetMeta.properties?.sheetId!;

  // Delete in descending order so row indices stay valid as we remove rows.
  orphanedIndices.sort((a, b) => b - a);

  // Batch into groups of 100 to stay within batchUpdate request limits.
  const BATCH = 100;
  for (let start = 0; start < orphanedIndices.length; start += BATCH) {
    const chunk = orphanedIndices.slice(start, start + BATCH);
    const requests = chunk.map((rowIdx) => ({
      deleteRange: {
        range: {
          sheetId: tabSheetId,
          startRowIndex: rowIdx,
          endRowIndex: rowIdx + 1,
        },
        shiftDimension: "ROWS",
      },
    }));
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests },
    });
  }

  log(`Cleanup: deleted ${orphanedIndices.length} orphaned assignment row(s)`);
}

// ─── Step: Sync Groups Tab ────────────────────────────────────────────────────
//
// Derives group names from the Categories tab and ensures each appears in Groups.
// Preserves existing rows — budget_type and rollover settings are user-editable
// directly in the sheet and must not be overwritten by setup reruns.

async function syncGroupsTab(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[]
): Promise<void> {
  const meta = findSheet(sheetMeta, "Groups");
  if (!meta) {
    log("Groups: tab not found, skipping");
    return;
  }

  // Derive distinct group names from the Categories tab (column A = category_group)
  const catRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `Categories!A${CATEGORIES_START_ROW}:A${CATEGORIES_END_ROW}`,
  });
  const groupNames = [
    ...new Set(
      (catRes.data.values ?? []).map((r) => (r[0] ?? "").toString().trim()).filter(Boolean)
    ),
  ];

  if (groupNames.length === 0) {
    log("Groups: Categories tab is empty, skipping group sync");
    return;
  }

  // Read existing group names from the Groups tab
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Groups!A2:A",
  });
  const existingNames = new Set(
    (existing.data.values ?? []).map((r) => (r[0] ?? "").toString().trim()).filter(Boolean)
  );

  const toAdd = groupNames.filter((g) => !existingNames.has(g));

  if (toAdd.length === 0) {
    log("Groups: all groups already present, skipping");
    return;
  }

  const rows = toAdd.map((name) => [
    name,
    "by_category",  // default budget_type — user can change in sheet
    "FALSE",        // rollover
    "",             // rollover_start_month
    0,              // monthly_template_amount
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: "Groups!A2",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });

  log(`Groups: added ${toAdd.length} group(s): ${toAdd.join(", ")}`);
}

// ─── Step: Migrate v6 → v7 ───────────────────────────────────────────────────
//
// Detects the old Budget tab layout (ReadyToAssign at A1) and migrates in-place:
//   - Category rows (Budget!A7:G506) → Categories!A2
//   - Assignment rows (Budget!A509:E) → Budget!A2
//   - Budget tab cleared and rewritten with assignments only
//
// Idempotent: if Budget!A1 is not "ReadyToAssign", migration is skipped.

async function migrateV6ToV7(
  sheets: sheets_v4.Sheets,
  sheetId: string
): Promise<void> {
  const check = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Budget!A1",
  });
  const a1 = check.data.values?.[0]?.[0] ?? "";
  if (a1 !== "ReadyToAssign") {
    log("Migration: Budget tab already in v7 format, skipping");
    return;
  }

  log("Migration: detected v6 Budget format — migrating to v7...");

  // Read category data from old Budget rows 7–506
  const catRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Budget!A7:G506",
  });
  const catRows = catRes.data.values ?? [];
  log(`Migration: read ${catRows.length} category row(s) from Budget!A7:G506`);

  // Read assignment data from old Budget rows 509+
  const assignRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Budget!A509:E",
  });
  const assignRows = assignRes.data.values ?? [];
  log(`Migration: read ${assignRows.length} assignment row(s) from Budget!A509:E`);

  // Write categories to the new Categories tab
  if (catRows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: "Categories!A2",
      valueInputOption: "RAW",
      requestBody: { values: catRows },
    });
    log("Migration: wrote categories to Categories!A2");
  }

  // Clear entire Budget tab, then rewrite with assignments only
  await sheets.spreadsheets.values.clear({
    spreadsheetId: sheetId,
    range: "Budget",
  });

  // Write assignment column header at row 1
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: "Budget!A1",
    valueInputOption: "RAW",
    requestBody: { values: [BUDGET_ASSIGNMENTS_COLUMNS] },
  });

  // Write assignment data starting at row 2
  if (assignRows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: "Budget!A2",
      valueInputOption: "RAW",
      requestBody: { values: assignRows },
    });
    log(`Migration: wrote ${assignRows.length} assignment row(s) to Budget!A2`);
  }

  log("Migration: v6 → v7 complete");
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

  // 2. Authenticate
  const auth = new google.auth.GoogleAuth({
    ...(authConfig.kind === "keyFile"
      ? { keyFile: authConfig.keyPath }
      : { credentials: authConfig.credentials }),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  // Set a global 120-second timeout on all API calls. Without this, the googleapis
  // HTTP client has no timeout and will hang indefinitely if Google Sheets is busy
  // computing heavy formulas (e.g. SUM over entire Transactions columns).
  // 120s is needed for large writeBudgetCalcs chunk writes (600+ formula rows each).
  google.options({ timeout: 120_000 });

  const sheets = google.sheets({ version: "v4", auth });
  log("Authenticated with Google Sheets API");

  // 4. Get current sheet state
  let sheetMeta = await getSheetMetadata(sheets, sheetId);
  log(`Found ${sheetMeta.length} existing tab(s)`);

  // 4a. Read current sheet version BEFORE any writes, so we can skip formatting
  // steps that are already up to date. One cheap read here avoids 5+ batchUpdate
  // calls (headers, widths, conditional formatting, two validation passes) that
  // hit the API rate limit on every run even when nothing has changed.
  const existingVersionRes = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Reflect!A1:B1",
  }).catch(() => ({ data: { values: undefined } }));
  const existingVersion = Number(existingVersionRes.data.values?.[0]?.[1] ?? 0);
  const versionCurrent = (
    existingVersionRes.data.values?.[0]?.[0] === "sheet_version" &&
    existingVersion === SHEET_VERSION
  );

  // 4b. Migrate legacy tab names (rename/delete retired tabs before ensureTabsExist)
  await migrateLegacyTabs(sheets, sheetId, sheetMeta);
  // Refresh sheetMeta after migrations — use the same lightweight fields as
  // getSheetMetadata (no protectedRanges — lockTab fetches those separately).
  sheetMeta = await getSheetMetadata(sheets, sheetId);

  // 5. Ensure all tabs exist (Categories and Dashboard created here if new)
  const tabCountBefore = sheetMeta.length;
  sheetMeta = await ensureTabsExist(sheets, sheetId, sheetMeta);
  const newTabsCreated = sheetMeta.length > tabCountBefore;

  // 5a. Migrate v6 → v7: move Budget category/dashboard data to dedicated tabs
  await migrateV6ToV7(sheets, sheetId);

  // 6. Write Meta tab FIRST — before any other writes. The Meta tab contains
  // live SUM/SUMIF formulas (ReadyToAssign etc.) that Google Sheets must
  // evaluate before serving any values.get on this spreadsheet. If we run
  // writeMetaTab after many batchUpdate/values.update calls (which invalidate
  // the formula cache), the subsequent values.get hangs waiting for a full
  // recalculation. Running it here, while the sheet is idle, keeps it fast.
  await writeMetaTab(sheets, sheetId, sheetMeta);

  // Steps 7–9b (headers, widths, formatting, validations) are all idempotent
  // batchUpdate calls. Skip them when the sheet is already at the current version
  // and no new tabs were created — this avoids exhausting the API rate limit on
  // every run with calls that change nothing.
  const needsFormatting = !versionCurrent || newTabsCreated;
  if (needsFormatting) {
    log(`Formatting: running full pass (version=${existingVersion}→${SHEET_VERSION}, newTabs=${newTabsCreated})`);
  } else {
    log(`Formatting: sheet already at v${SHEET_VERSION}, skipping header/width/formatting/validation steps`);
  }

  // 7. Write headers + freeze + format
  if (needsFormatting) {
    await withRetry("writeHeaders", () => writeHeaders(sheets, sheetId, sheetMeta));
  }

  // 8. Set column widths
  if (needsFormatting) {
    await withRetry("setColumnWidths", () => setColumnWidths(sheets, sheetId, sheetMeta));
  }

  // 9. Apply conditional formatting to Transactions
  if (needsFormatting) {
    await withRetry("applyConditionalFormatting", () => applyConditionalFormatting(sheets, sheetId, sheetMeta));
  }

  // 9a. Category data validation (dropdown from Categories list)
  if (needsFormatting) {
    await withRetry("addCategoryDataValidation", () => addCategoryDataValidation(sheets, sheetId, sheetMeta));
  }

  // 9b. Additional validations: reviewed checkbox, transaction_type, Budget category, Categories group+type
  if (needsFormatting) {
    await withRetry("addAdditionalValidations", () => addAdditionalValidations(sheets, sheetId, sheetMeta));
  }

  // 9c. Account validation: Transactions!account validated against Accounts canonical_name list
  if (needsFormatting) {
    await withRetry("addAccountValidation", () => addAccountValidation(sheets, sheetId, sheetMeta));
  }

  // 10. Lock BankToSheets-managed tabs
  await withRetry("lockBankToSheetsRaw", () => lockBankToSheetsRaw(sheets, sheetId, sheetMeta));
  await withRetry("lockBalanceHistory", () => lockTab(sheets, sheetId, sheetMeta, "Balance History (BTS)"));

  // 11. Hide process-managed tabs (Meta, Budget_Log, Budget_Calcs, BTS tabs)
  await withRetry("hideProcessTabs", () => hideProcessTabs(sheets, sheetId, sheetMeta));

  // 13. Write Budget_Calcs formulas (activity + available with rollover, per category per month)
  // Most expensive step — clears and rewrites 60+ months × N category rows.
  await withRetry("writeBudgetCalcs", () => writeBudgetCalcs(sheets, sheetId, sheetMeta));

  // 14. Write sheet version
  await withRetry("writeSheetVersion", () => writeSheetVersion(sheets, sheetId));

  // 14b. Set up Accounts tab: headers, formatting, first-run seed from Transactions history
  // Runs unconditionally (not gated on needsFormatting) because seeding is data-driven and
  // idempotent — it only writes rows when the tab is empty.
  await withRetry("setupAccountsTab", () => setupAccountsTab(sheets, sheetId, sheetMeta));

  // 15. Sync Groups tab — add any new groups derived from Categories tab (preserves existing settings)
  await withRetry("syncGroupsTab", () => syncGroupsTab(sheets, sheetId, sheetMeta));

  // 16. Clean up orphaned assignment rows (month stored as date serial instead of YYYY-MM text)
  await withRetry("cleanOrphanedAssignmentRows", () => cleanOrphanedAssignmentRows(sheets, sheetId, sheetMeta));

  console.log(
    "\n── Setup complete ───────────────────────────────────────────\n"
  );
}

main().catch((err) => {
  console.error("\n  ✗ Unexpected error:", err.message ?? err);
  process.exit(1);
});
