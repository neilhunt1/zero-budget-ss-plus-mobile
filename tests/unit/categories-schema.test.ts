import { describe, it, expect, beforeAll } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import schema from '../../config/categories.schema.json';
import categories from '../../config/categories.json';

// ─── Schema validation ────────────────────────────────────────────────────────

describe('categories.json schema validation', () => {
  let validate: ReturnType<Ajv['compile']>;

  beforeAll(() => {
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    validate = ajv.compile(schema);
  });

  it('passes schema validation', () => {
    const valid = validate(categories);
    const errors = validate.errors
      ?.map((e) => `${e.instancePath}: ${e.message}`)
      .join('\n');
    expect(valid, errors).toBe(true);
  });

  it('has a version field', () => {
    const version = (categories as { version: unknown }).version;
    expect(version).toBeDefined();
    expect(['string', 'number']).toContain(typeof version);
  });

  it('has at least one group', () => {
    expect((categories as { groups: unknown[] }).groups.length).toBeGreaterThan(0);
  });
});

// ─── Category name uniqueness ─────────────────────────────────────────────────

describe('categories.json data integrity', () => {
  type Category = { name: string; type: string; template?: number };
  type Subgroup = { name: string; categories: Category[] };
  type Group = { name: string; subgroups?: Subgroup[]; categories?: Category[] };
  type Config = { groups: Group[] };

  const config = categories as unknown as Config;

  function allCategories(): Array<{ group: string; subgroup: string; name: string; type: string }> {
    const result = [];
    for (const group of config.groups) {
      if (group.subgroups) {
        for (const subgroup of group.subgroups) {
          for (const cat of subgroup.categories) {
            result.push({ group: group.name, subgroup: subgroup.name, name: cat.name, type: cat.type });
          }
        }
      } else if (group.categories) {
        for (const cat of group.categories) {
          result.push({ group: group.name, subgroup: '', name: cat.name, type: cat.type });
        }
      }
    }
    return result;
  }

  it('has no duplicate category names', () => {
    const cats = allCategories();
    const names = cats.map((c) => c.name);
    const dupes = names.filter((name, i) => names.indexOf(name) !== i);
    expect(dupes, `Duplicate categories: ${dupes.join(', ')}`).toEqual([]);
  });

  it('has no duplicate group names', () => {
    const groupNames = config.groups.map((g) => g.name);
    const dupes = groupNames.filter((name, i) => groupNames.indexOf(name) !== i);
    expect(dupes, `Duplicate groups: ${dupes.join(', ')}`).toEqual([]);
  });

  it('every category has a valid type', () => {
    const validTypes = ['fluid', 'fixed_bill', 'savings_target', 'targeted_amount'];
    const invalid = allCategories().filter((c) => !validTypes.includes(c.type));
    expect(
      invalid,
      `Invalid types: ${invalid.map((c) => `${c.name}=${c.type}`).join(', ')}`
    ).toEqual([]);
  });

  it('no group has both subgroups and direct categories', () => {
    const violations = config.groups.filter((g) => g.subgroups && g.categories);
    expect(
      violations.map((g) => g.name),
      'Groups cannot have both subgroups and categories'
    ).toEqual([]);
  });

  it('no group has neither subgroups nor direct categories', () => {
    const violations = config.groups.filter((g) => !g.subgroups && !g.categories);
    expect(violations.map((g) => g.name), 'Empty groups').toEqual([]);
  });

  it('all categories have non-empty names', () => {
    const empty = allCategories().filter((c) => !c.name || !c.name.trim());
    expect(empty, 'Categories with empty names').toEqual([]);
  });

  it('template amounts are non-negative numbers', () => {
    const invalid: string[] = [];
    for (const group of config.groups) {
      const cats = group.subgroups
        ? group.subgroups.flatMap((s) => s.categories)
        : (group.categories ?? []);
      for (const cat of cats) {
        if (cat.template !== undefined && (typeof cat.template !== 'number' || cat.template < 0)) {
          invalid.push(cat.name);
        }
      }
    }
    expect(invalid, `Negative/invalid template amounts: ${invalid.join(', ')}`).toEqual([]);
  });
});
