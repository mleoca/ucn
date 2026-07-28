export type ProductStatus = 'draft' | 'active' | 'retired';

export interface Product {
    id: string;
    sku: string;
    name: string;
    priceCents: number;
    status: ProductStatus;
    tags: string[];
}

export interface CatalogQuery {
    text?: string;
    status?: ProductStatus;
    tags?: string[];
    minPriceCents?: number;
    maxPriceCents?: number;
}

export interface CatalogPage {
    items: Product[];
    total: number;
    nextCursor?: string;
}

export function normalizeSku(value: string): string {
    return value.trim().toUpperCase().replace(/\s+/g, '-');
}

export function normalizeProduct(product: Product): Product {
    return {
        ...product,
        sku: normalizeSku(product.sku),
        name: product.name.trim(),
        tags: [...new Set(product.tags.map(tag => tag.trim().toLowerCase()))],
    };
}

export function matchesCatalogQuery(
    product: Product,
    query: CatalogQuery,
): boolean {
    if (query.status && product.status !== query.status) return false;
    if (query.minPriceCents != null &&
        product.priceCents < query.minPriceCents) return false;
    if (query.maxPriceCents != null &&
        product.priceCents > query.maxPriceCents) return false;
    if (query.tags?.length &&
        !query.tags.every(tag => product.tags.includes(tag.toLowerCase()))) {
        return false;
    }
    if (query.text) {
        const needle = query.text.toLowerCase();
        const haystack = `${product.sku} ${product.name} ${product.tags.join(' ')}`
            .toLowerCase();
        if (!haystack.includes(needle)) return false;
    }
    return true;
}

export function searchCatalog(
    products: Product[],
    query: CatalogQuery,
    cursor = 0,
    pageSize = 25,
): CatalogPage {
    const matched = products
        .map(normalizeProduct)
        .filter(product => matchesCatalogQuery(product, query))
        .sort((left, right) => left.sku.localeCompare(right.sku));
    const items = matched.slice(cursor, cursor + pageSize);
    const next = cursor + items.length;
    return {
        items,
        total: matched.length,
        ...(next < matched.length && { nextCursor: String(next) }),
    };
}

export function activateProduct(product: Product): Product {
    if (product.status === 'retired') {
        throw new Error(`Cannot activate retired product ${product.sku}`);
    }
    return { ...product, status: 'active' };
}

export function retireProduct(product: Product): Product {
    return { ...product, status: 'retired' };
}

export function updateProductPrice(
    product: Product,
    priceCents: number,
): Product {
    if (!Number.isInteger(priceCents) || priceCents < 0) {
        throw new Error('priceCents must be a non-negative integer');
    }
    return { ...product, priceCents };
}

export function groupProductsByStatus(
    products: Product[],
): Record<ProductStatus, Product[]> {
    const grouped: Record<ProductStatus, Product[]> = {
        draft: [],
        active: [],
        retired: [],
    };
    for (const product of products) {
        grouped[product.status].push(product);
    }
    return grouped;
}

export function catalogValue(products: Product[]): number {
    return products
        .filter(product => product.status === 'active')
        .reduce((sum, product) => sum + product.priceCents, 0);
}
