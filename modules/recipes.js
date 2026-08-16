
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Follow a candidate recipe's ingredients down through any nested composites to
 * make sure the product does not end up consuming itself. Without this a recipe
 * pair like "Combo A uses Combo B" / "Combo B uses Combo A" would make stock
 * deduction recurse forever the first time either one is sold.
 */
function findsCycle(store, productId, ingredients, seen = new Set()) {
  if (seen.has(productId)) return true;
  seen.add(productId);

  for (const ingredient of ingredients || []) {
    if (ingredient.productId === productId) return true;

    const nested = (store.recipes || []).find((r) => r.productId === ingredient.productId);
    if (nested && findsCycle(store, ingredient.productId, nested.ingredients, new Set(seen))) {
      return true;
    }
  }

  return false;
}

/**
 * Validate and normalise a recipe payload against the catalogue.
 * Throws with a message meant for the user; the caller turns it into a 400.
 */
function buildRecipe(store, product, payload = {}) {
  const raw = Array.isArray(payload.ingredients) ? payload.ingredients : [];

  const ingredients = raw
    .filter((i) => i && i.productId && Number(i.qty) > 0)
    .map((i) => {
      const material = (store.products || []).find((p) => p.id === i.productId);
      if (!material) {
        throw new Error(`Raw material "${i.name || i.productId}" is not in the product catalogue.`);
      }
      return {
        productId: material.id,
        name: material.name,
        qty: Number(i.qty),
        unit: material.unit || i.unit || 'pcs',
        cost: r2(material.purchasePrice)
      };
    });

  if (!ingredients.length) {
    throw new Error('A composite item needs at least one raw material with a quantity.');
  }

  if (ingredients.some((i) => i.productId === product.id)) {
    throw new Error('A composite item cannot list itself as one of its own raw materials.');
  }

  if (findsCycle(store, product.id, ingredients)) {
    throw new Error('That recipe is circular — one of the raw materials is itself made from this product.');
  }

  const batchCost = ingredients.reduce((sum, i) => sum + i.cost * i.qty, 0);

  const existing = (store.recipes || []).find((r) => r.productId === product.id);

  return {
    id: existing?.id || `rec_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    productId: product.id,
    productName: product.name,
    yieldQty: 1,
    ingredients,
    // Cost of one sellable unit — 1:1 with batch cost (no yield multiplier).
    unitCost: r2(batchCost),
    batchCost: r2(batchCost),
    notes: payload.notes || existing?.notes || '',
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function setRecipe(store, product, payload) {
  if (!Array.isArray(store.recipes)) store.recipes = [];

  const others = store.recipes.filter((r) => r.productId !== product.id);

  if (!payload || !Array.isArray(payload.ingredients) || payload.ingredients.length === 0) {
    store.recipes = others;
    product.isComposite = false;
    product.recipeItems = [];
    return null;
  }

  const recipe = buildRecipe(store, product, payload);
  store.recipes = [...others, recipe];

  product.isComposite = true;
  product.productType = 'composite';
  // Mirrored onto the product so a single GET /products call is enough to render
  // the recipe back into the edit form.
  product.recipeItems = recipe.ingredients;
  product.recipeYieldQty = 1;
  product.recipeUnitCost = recipe.unitCost;
  // A composite is costed from its ingredients, never from a typed-in figure.
  product.purchasePrice = recipe.unitCost;

  return recipe;
}

function removeRecipe(store, productId) {
  if (!Array.isArray(store.recipes)) store.recipes = [];
  store.recipes = store.recipes.filter((r) => r.productId !== productId);
}

/** Recipe plus the live figures the UI shows next to it. */
function decorateRecipe(store, recipe) {
  const product = (store.products || []).find((p) => p.id === recipe.productId);

  const ingredients = recipe.ingredients.map((i) => {
    const material = (store.products || []).find((p) => p.id === i.productId);
    return {
      ...i,
      cost: material ? r2(material.purchasePrice) : i.cost,
      available: material ? material.stock : 0,
      unit: material ? material.unit : i.unit,
      missing: !material
    };
  });

  const batchCost = ingredients.reduce((sum, i) => sum + (i.cost || 0) * i.qty, 0);
  const unitCost = r2(batchCost);

  // How many sellable units the raw materials on hand can actually produce —
  // strict 1:1 ratio with listed ingredients.
  const producible = ingredients.length
    ? Math.floor(
        Math.min(
          ...ingredients.map((i) => (i.qty > 0 ? i.available / i.qty : 0))
        )
      )
    : 0;

  const sellingPrice = product ? product.price : 0;

  return {
    ...recipe,
    ingredients,
    unitCost,
    batchCost: r2(batchCost),
    sellingPrice,
    margin: r2(sellingPrice - unitCost),
    marginPercent: sellingPrice ? r2(((sellingPrice - unitCost) / sellingPrice) * 100) : 0,
    producible: Number.isFinite(producible) ? Math.max(0, producible) : 0,
    stockStatus: producible <= 0 ? 'OUT_OF_STOCK' : producible <= 5 ? 'LOW' : 'HEALTHY'
  };
}

/**
 * Extract a recipe payload from a product form submission. The client may send
 * it as `recipe`, or flat as `recipeItems`.
 */
function recipeFromProductPayload(payload = {}) {
  if (payload.recipe && typeof payload.recipe === 'object') return payload.recipe;
  if (Array.isArray(payload.recipeItems)) {
    return { ingredients: payload.recipeItems, yieldQty: 1, notes: payload.recipeNotes };
  }
  return null;
}

module.exports = { buildRecipe, setRecipe, removeRecipe, decorateRecipe, recipeFromProductPayload, findsCycle };
