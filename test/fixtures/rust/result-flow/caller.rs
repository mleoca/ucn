pub fn crate_alias() { assert!(crate::Error::build().message()); }
use crate::contracts as factories;

fn module_factory() {
    let item = factories::make();
    item.ping();
}
fn module_chain() { factories::make().ping(); }
fn qualified_macro(item: &crate::Local) { assert!(item.ready()); }
fn qualified_foreign_macro(item: &crate::Other) { assert!(item.ready()); }
fn module_unresolved<T: crate::Has + Default>() {
    let item = factories::generic::<T>();
    item.ping();
}
