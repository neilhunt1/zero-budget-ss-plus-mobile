/**
 * Standalone validator for config/categories.json.
 * Run with: npm run validate:categories
 * Exits 1 on any violation so CI can block on it.
 */

import * as path from "path";
import * as fs from "fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Category {
  name: string;
  type: string;
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

let errors = 0;

function fail(msg: string): void {
  console.error(`  ✗ ${msg}`);
  errors++;
}

function pass(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function allCategories(config: CategoriesConfig): Array<{ group: string; subgroup: string; cat: Category }> {
  const result: Array<{ group: string; subgroup: string; cat: Category }> = [];
  for (const group of config.groups) {
    if (group.subgroups) {
      for (const subgroup of group.subgroups) {
        for (const cat of subgroup.categories) {
          result.push({ group: group.name, subgroup: subgroup.name, cat });
        }
      }
    } else if (group.categories) {
      for (const cat of group.categories) {
        result.push({ group: group.name, subgroup: "", cat });
      }
    }
  }
  return result;
}

function dupes<T>(items: T[]): T[] {
  return items.filter((item, i) => items.indexOf(item) !== i);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const schemaPath = path.resolve(process.cwd(), "config/categories.schema.json");
const dataPath = path.resolve(process.cwd(), "config/categories.json");

if (!fs.existsSync(schemaPath)) {
  console.error(`Missing ${schemaPath}`);
  process.exit(1);
}
if (!fs.existsSync(dataPath)) {
  console.error(`Missing ${dataPath}`);
  process.exit(1);
}

const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
const data: CategoriesConfig = JSON.parse(fs.readFileSync(dataPath, "utf-8"));

console.log(`\nValidating config/categories.json (version ${data.version})\n`);

// ── 1. AJV schema validation ──────────────────────────────────────────────────
console.log("Schema validation:");
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

if (!validate(data)) {
  const msgs = validate.errors
    ?.map((e) => `    ${e.instancePath || "root"}: ${e.message}`)
    .join("\n");
  fail(`categories.json does not match schema:\n${msgs}`);
} else {
  pass(`matches schema`);
}

// ── 2. Duplicate group names ──────────────────────────────────────────────────
console.log("\nGroup integrity:");
const groupNames = data.groups.map((g) => g.name);
const dupGroups = dupes(groupNames);
if (dupGroups.length) {
  fail(`duplicate group names: ${dupGroups.join(", ")}`);
} else {
  pass(`no duplicate group names (${groupNames.length} groups)`);
}

// ── 3. sort_order uniqueness per group ────────────────────────────────────────
for (const group of data.groups) {
  const containers = group.subgroups ?? [];
  const sortOrders = containers
    .map((s) => s.sort_order)
    .filter((v): v is number => v !== undefined);
  const dupOrders = dupes(sortOrders);
  if (dupOrders.length) {
    fail(`group "${group.name}" has duplicate subgroup sort_order values: ${dupOrders.join(", ")}`);
  }
}

// ── 4. Category name uniqueness (global) ──────────────────────────────────────
console.log("\nCategory integrity:");
const cats = allCategories(data);
const catNames = cats.map((c) => c.cat.name);
const dupCats = dupes(catNames);
if (dupCats.length) {
  fail(`duplicate category names: ${dupCats.join(", ")}`);
} else {
  pass(`no duplicate category names (${catNames.length} categories)`);
}

// ── 5. sort_order uniqueness within each parent ───────────────────────────────
function checkCatSortOrders(items: Category[], context: string): void {
  const orders = items
    .map((c) => c.sort_order)
    .filter((v): v is number => v !== undefined);
  const dupOrders = dupes(orders);
  if (dupOrders.length) {
    fail(`${context} has duplicate category sort_order values: ${dupOrders.join(", ")}`);
  }
}

for (const group of data.groups) {
  if (group.subgroups) {
    for (const subgroup of group.subgroups) {
      checkCatSortOrders(subgroup.categories, `"${group.name} > ${subgroup.name}"`);
    }
  } else if (group.categories) {
    checkCatSortOrders(group.categories, `"${group.name}"`);
  }
}

// ── 6. All categories have non-empty names ────────────────────────────────────
const emptyNames = cats.filter((c) => !c.cat.name?.trim());
if (emptyNames.length) {
  fail(`${emptyNames.length} category/categories have empty names`);
} else {
  pass(`all categories have non-empty names`);
}

// ── Result ────────────────────────────────────────────────────────────────────
console.log();
if (errors > 0) {
  console.error(`\nFailed with ${errors} error(s).\n`);
  process.exit(1);
} else {
  console.log(`All checks passed.\n`);
  process.exit(0);
}
