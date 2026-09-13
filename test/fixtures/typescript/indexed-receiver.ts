class Local { ping(): void {} }
class Other { ping(): void {} }

function parameter(items: Local[]): void { items[0].ping(); }
function numericIndex(items: Local[], i: number): void { items[i].ping(); }
function captured(): void {
    let items: Local[] | undefined;
    items = [];
    function visit(): void {
        if (items) {
            for (let i = 0; i < items.length; i++) items[i].ping();
        }
    }
    visit();
}
function foreign(items: Other[]): void { items[0].ping(); }
function union(items: Local[] | Other[]): void { items[0].ping(); }
function unknown(items: any[]): void { items[0].ping(); }
function generic<Local extends { ping(): void }>(items: Local[]): void { items[0].ping(); }
function dynamicIndex(items: Local[], i: any): void { items[i].ping(); }
function namedProperty(items: Local[] & { custom: Other }): void { items["custom"].ping(); }
function outer(items: Local[], i: number): void {
    function untyped(items: any[]): void { items[0].ping(); }
    function shadow(items: Other[]): void { items[0].ping(); }
    function indexShadow(i: any): void { items[i].ping(); }
    {
        const items: Other[] = [];
        items[0].ping();
    }
}
