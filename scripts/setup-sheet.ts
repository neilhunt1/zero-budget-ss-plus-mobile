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

// Monthly assignments live on a separate section of the Budget tab, starting
// after a blank spacer row at BUDGET_ASSIGNMENTS_START_ROW.
const BUDGET_ASSIGNMENTS_START_ROW = 502; // rows 2–501 reserved for categories
const BUDGET_ASSIGNMENTS_COLUMNS = ["month", "category", "assigned"];

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

const TABS_IN_ORDER = [
  "Transactions",
  "Budget",
  "Templates",
  "Reflect",
  "BankToSheets_Raw",
  "YNAB_Import",
];

// Header background color (Google blue)
const HEADER_BG_COLOR = { red: 0.29, green: 0.525, blue: 0.91 };
const HEADER_FG_COLOR = { red: 1, green: 1, blue: 1 };

// Sheet schema version — increment when structure changes
const SHEET_VERSION = 1;

// ─── Environment Loading ───────────────────────────────────────────────────────

function loadEnv(): { sheetId: string; keyPath: string } {
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

  if (!fs.existsSync(envPath)) {
    bail(
      `Missing ${envFile}. Copy .env.example to ${envFile} and fill in values.`
    );
  }

  // Manual dotenv parse — avoids requiring dotenv at top level for type safety
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

  const sheetId = process.env.GOOGLE_SHEET_ID;
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;

  if (!sheetId || sheetId === "your_sheet_id_here") {
    bail(`GOOGLE_SHEET_ID is not set in ${envFile}.`);
  }
  if (!keyPath) {
    bail(`GOOGLE_SERVICE_ACCOUNT_KEY_PATH is not set in ${envFile}.`);
  }

  const resolvedKeyPath = path.resolve(process.cwd(), keyPath);
  if (!fs.existsSync(resolvedKeyPath)) {
    bail(
      `Service account key file not found: ${resolvedKeyPath}\n` +
        `Download it from Google Cloud Console → IAM → Service Accounts → Keys.`
    );
  }

  log(`Loaded env from ${envFile} (sheet: ${sheetId})`);
  return { sheetId, keyPath: resolvedKeyPath };
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
  // Check existing row 1 values for each tab that gets headers
  const tabHeaders: Array<{ title: string; columns: string[]; row?: number }> = [
    { title: "Transactions", columns: TRANSACTIONS_COLUMNS },
    { title: "Budget", columns: BUDGET_CATEGORY_COLUMNS },
    { title: "Templates", columns: TEMPLATES_COLUMNS },
  ];

  const formatRequests: sheets_v4.Schema$Request[] = [];

  for (const { title, columns } of tabHeaders) {
    const meta = findSheet(sheetMeta, title);
    if (!meta) continue;

    const tabSheetId = meta.properties?.sheetId!;

    // Check if row 1 already has data
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${title}!1:1`,
    });

    const currentValues = existing.data.values?.[0] ?? [];

    if (currentValues.length > 0) {
      log(`Headers: ${title} already has headers, skipping`);
    } else {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `${title}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [columns] },
      });
      log(`Headers: wrote ${columns.length} columns to ${title}`);
    }

    // Format row 1: bold, background color, frozen
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

  // Write Budget monthly assignments header at BUDGET_ASSIGNMENTS_START_ROW
  const budgetMeta = findSheet(sheetMeta, "Budget");
  if (budgetMeta) {
    const assignmentsRange = `Budget!A${BUDGET_ASSIGNMENTS_START_ROW}`;
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `Budget!A${BUDGET_ASSIGNMENTS_START_ROW}:C${BUDGET_ASSIGNMENTS_START_ROW}`,
    });
    if (!existing.data.values?.[0]?.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: assignmentsRange,
        valueInputOption: "RAW",
        requestBody: { values: [BUDGET_ASSIGNMENTS_COLUMNS] },
      });
      // Add a label row above the assignments section
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `Budget!A${BUDGET_ASSIGNMENTS_START_ROW - 1}`,
        valueInputOption: "RAW",
        requestBody: { values: [["── Monthly Assignments ──"]] },
      });
      log(`Headers: wrote monthly assignments header to Budget row ${BUDGET_ASSIGNMENTS_START_ROW}`);

      // Format the assignments header row
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

async function seedBudgetCategories(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  categories: FlatCategory[]
): Promise<void> {
  // Read existing category rows (skip header row 1)
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "Budget!A2:G500",
  });

  const existingRows = existing.data.values ?? [];
  const existingNames = new Set(existingRows.map((r) => r[2] as string).filter(Boolean));

  const toAdd = categories.filter((c) => !existingNames.has(c.category));

  if (toAdd.length === 0) {
    log(`Budget seed: all ${categories.length} categories already present, skipping`);
    return;
  }

  const newRows = toAdd.map((c) => [
    c.group,
    c.subgroup,
    c.category,
    c.type,
    c.template,
    c.sort_order,
    c.active ? "TRUE" : "FALSE",
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: "Budget!A2",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: newRows },
  });

  log(`Budget seed: added ${toAdd.length} categories (${existingRows.length} already existed)`);
}

// ─── Step: Lock BankToSheets_Raw ──────────────────────────────────────────────

async function lockBankToSheetsRaw(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[]
): Promise<void> {
  const meta = findSheet(sheetMeta, "BankToSheets_Raw");
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
    log("Lock: BankToSheets_Raw already protected, skipping");
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

  log("Lock: BankToSheets_Raw tab protected (warn on edit)");
}

// ─── Step: Hide YNAB_Import ───────────────────────────────────────────────────

async function hideYnabImport(
  sheets: sheets_v4.Sheets,
  sheetId: string,
  sheetMeta: sheets_v4.Schema$Sheet[]
): Promise<void> {
  const meta = findSheet(sheetMeta, "YNAB_Import");
  if (!meta) return;

  if (meta.properties?.hidden) {
    log("Hide: YNAB_Import already hidden, skipping");
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId: meta.properties?.sheetId,
              hidden: true,
            },
            fields: "hidden",
          },
        },
      ],
    },
  });

  log("Hide: YNAB_Import tab hidden");
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
  const { sheetId, keyPath } = loadEnv();

  // 2. Validate categories
  const categoriesConfig = loadAndValidateCategories();
  const flatCategories = flattenCategories(categoriesConfig);

  // 3. Authenticate
  const auth = new google.auth.GoogleAuth({
    keyFile: keyPath,
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

  // 9. Seed Budget tab with categories
  await seedBudgetCategories(sheets, sheetId, flatCategories);

  // 10. Lock BankToSheets_Raw
  await lockBankToSheetsRaw(sheets, sheetId, sheetMeta);

  // 11. Hide YNAB_Import
  await hideYnabImport(sheets, sheetId, sheetMeta);

  // 12. Write sheet version
  await writeSheetVersion(sheets, sheetId);

  console.log(
    "\n── Setup complete ───────────────────────────────────────────\n"
  );
}

main().catch((err) => {
  console.error("\n  ✗ Unexpected error:", err.message ?? err);
  process.exit(1);
});
