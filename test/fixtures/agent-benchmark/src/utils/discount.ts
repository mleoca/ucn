// applyRebate — alias-call refactor target. The aliased call site's line
// does NOT contain the name (beyond-text): plain grep misses it; resolution
// must follow the alias binding.
export function applyRebate(total: number, percent: number): number {
    return total - (total * percent) / 100;
}

export function quoteWithMemberRebate(total: number): number {
    const apply = applyRebate;
    return apply(total, 10);
}

export function quoteWithSeasonal(total: number): number {
    return applyRebate(total, 5);
}
