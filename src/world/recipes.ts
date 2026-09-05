/** Crafting: shaped + shapeless recipes for a 2×2 / 3×3 grid (IN-3). */
import { BlockId } from './blocks.js';
import { ItemId } from './items.js';

export interface Recipe {
  id: string;
  result: { id: number; count: number };
  /** unordered ingredient list */
  shapeless?: number[];
  /** rows of item ids, 0 = empty (max 3×3) */
  pattern?: number[][];
  /** only craftable at a crafting table (3×3 grid) */
  needsTable?: boolean;
}

const P = BlockId.PLANKS;
const S = ItemId.STICK;
const COBBLE = BlockId.COBBLESTONE;

function toolSet(material: number, needsTable: boolean, idPrefix: string): Recipe[] {
  return [
    {
      id: `${idPrefix}_pickaxe`,
      result: { id: 200 + (material === P ? 0 : material === COBBLE ? 1 : material === ItemId.IRON ? 2 : 3), count: 1 },
      needsTable,
      pattern: [
        [material, material, material],
        [0, S, 0],
        [0, S, 0],
      ],
    },
    {
      id: `${idPrefix}_axe`,
      result: { id: 210 + (material === P ? 0 : material === COBBLE ? 1 : material === ItemId.IRON ? 2 : 3), count: 1 },
      needsTable,
      pattern: [
        [material, material],
        [material, S],
        [0, S],
      ],
    },
    {
      id: `${idPrefix}_shovel`,
      result: { id: 220 + (material === P ? 0 : material === COBBLE ? 1 : material === ItemId.IRON ? 2 : 3), count: 1 },
      needsTable,
      pattern: [
        [0, material, 0],
        [0, S, 0],
        [0, S, 0],
      ],
    },
    {
      id: `${idPrefix}_sword`,
      result: { id: 230 + (material === P ? 0 : material === COBBLE ? 1 : material === ItemId.IRON ? 2 : 3), count: 1 },
      needsTable,
      pattern: [
        [0, material, 0],
        [0, material, 0],
        [0, S, 0],
      ],
    },
  ];
}

export const RECIPES: Recipe[] = [
  { id: 'planks', result: { id: BlockId.PLANKS, count: 4 }, shapeless: [BlockId.LOG] },
  {
    id: 'sticks',
    result: { id: ItemId.STICK, count: 4 },
    pattern: [
      [P],
      [P],
    ],
  },
  {
    id: 'crafting_table',
    result: { id: BlockId.CRAFTING_TABLE, count: 1 },
    pattern: [
      [P, P],
      [P, P],
    ],
  },
  {
    id: 'torch',
    result: { id: BlockId.TORCH, count: 4 },
    pattern: [
      [ItemId.COAL],
      [S],
    ],
  },
  {
    id: 'chest',
    result: { id: BlockId.CHEST, count: 1 },
    needsTable: true,
    pattern: [
      [P, P, P],
      [P, 0, P],
      [P, P, P],
    ],
  },
  {
    id: 'bricks',
    result: { id: BlockId.BRICK, count: 4 },
    pattern: [
      [COBBLE, COBBLE],
      [COBBLE, COBBLE],
    ],
  },
  {
    id: 'sandstone',
    result: { id: BlockId.SANDSTONE, count: 2 },
    pattern: [
      [BlockId.SAND, BlockId.SAND],
      [BlockId.SAND, BlockId.SAND],
    ],
  },
  {
    id: 'glass',
    result: { id: BlockId.GLASS, count: 2 },
    pattern: [
      [BlockId.SAND],
      [BlockId.SAND],
    ],
  },
  {
    id: 'tnt',
    result: { id: BlockId.TNT, count: 1 },
    needsTable: true,
    pattern: [
      [BlockId.SAND, ItemId.GEM, BlockId.SAND],
      [ItemId.GEM, ItemId.COAL, ItemId.GEM],
      [BlockId.SAND, ItemId.GEM, BlockId.SAND],
    ],
  },
  ...toolSet(P, true, 'wood'),
  ...toolSet(COBBLE, true, 'stone'),
  ...toolSet(ItemId.IRON, true, 'iron'),
  ...toolSet(ItemId.GEM, true, 'gem'),
];

/** Trim empty rows/columns so a 2×2 pattern also matches inside a 3×3 grid. */
function trim(pattern: number[][]): number[][] {
  const rows = pattern.map((r) => [...r]);
  const emptyRow = (r: number[]) => r.every((v) => v === 0);
  while (rows.length && emptyRow(rows[0])) rows.shift();
  while (rows.length && emptyRow(rows[rows.length - 1])) rows.pop();
  if (rows.length === 0) return [];
  const width = rows[0].length;
  let left = width;
  let right = -1;
  for (const r of rows) {
    for (let i = 0; i < width; i++) {
      if (r[i] !== 0) {
        if (i < left) left = i;
        if (i > right) right = i;
      }
    }
  }
  if (right < left) return [];
  return rows.map((r) => r.slice(left, right + 1));
}

function patternsEqual(a: number[][], b: number[][]): boolean {
  if (a.length !== b.length) return false;
  for (let y = 0; y < a.length; y++) {
    if (a[y].length !== b[y].length) return false;
    for (let x = 0; x < a[y].length; x++) if (a[y][x] !== b[y][x]) return false;
  }
  return true;
}

function shapelessMatch(need: number[], grid: number[]): boolean {
  const have = grid.filter((id) => id !== 0);
  if (have.length !== need.length) return false;
  const sortedNeed = [...need].sort((p, q) => p - q);
  const sortedHave = [...have].sort((p, q) => p - q);
  return sortedNeed.every((v, i) => v === sortedHave[i]);
}

/** grid: row-major ids, size×size (2 or 3). Returns the matching recipe, if any. */
export function matchRecipe(grid: number[], size: number): Recipe | null {
  const rows: number[][] = [];
  for (let y = 0; y < size; y++) rows.push(grid.slice(y * size, y * size + size));
  const filled = grid.filter((id) => id !== 0).length;
  if (filled === 0) return null;

  const norm = trim(rows);
  for (const r of RECIPES) {
    if (r.shapeless) {
      if (r.needsTable && size < 3) continue;
      if (shapelessMatch(r.shapeless, grid)) return r;
      continue;
    }
    if (!r.pattern) continue;
    if (r.needsTable && size < 3) continue;
    if (patternsEqual(norm, trim(r.pattern))) return r;
  }
  return null;
}

export interface RecipeEntry {
  recipe: Recipe;
  /** ingredients available in the inventory (count of complete crafts possible) */
  possible: number;
}

function countOf(inv: Map<number, number>, id: number): number {
  return inv.get(id) ?? 0;
}

function ingredients(recipe: Recipe): Map<number, number> {
  const need = new Map<number, number>();
  const add = (id: number) => {
    if (!id) return;
    need.set(id, (need.get(id) ?? 0) + 1);
  };
  if (recipe.shapeless) recipe.shapeless.forEach(add);
  else if (recipe.pattern) for (const row of recipe.pattern) row.forEach(add);
  return need;
}

/** Recipe book state (IN-6): which recipes the player could craft right now. */
export function recipeBook(inventorySlots: ({ id: number; count?: number } | null | undefined)[]): RecipeEntry[] {
  const inv = new Map<number, number>();
  for (const s of inventorySlots) if (s && s.id) inv.set(s.id, (inv.get(s.id) ?? 0) + (s.count ?? 1));
  return RECIPES.map((recipe) => {
    let possible = Infinity;
    for (const [id, n] of ingredients(recipe)) {
      possible = Math.min(possible, Math.floor(countOf(inv, id) / n));
    }
    return { recipe, possible: possible === Infinity ? 0 : possible };
  });
}

export function recipeIngredients(recipe: Recipe): Map<number, number> {
  return ingredients(recipe);
}
