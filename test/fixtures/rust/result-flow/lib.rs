#![allow(dead_code, unused_variables)]
mod contracts;
mod fake;
mod error;
mod caller;
use contracts::Outcome as AppResult;
pub type Error = error::Error<()>;

#[derive(Debug)]
pub struct Local;
impl Local {
    pub fn ping(&self) {}
    pub fn ready(&self) -> bool { true }
    pub fn child(&self) -> &Local { self }
    pub fn new() -> Other { Other }
    pub fn produce(&self) -> Result<Local, ()> { Ok(Local) }
}
#[derive(Debug)]
pub struct Other;
impl Other {
    pub fn ping(&self) {}
    pub fn ready(&self) -> bool { false }
    pub fn produce(&self) -> Result<Other, ()> { Ok(Other) }
}
pub trait Has { fn ping(&self); }
fn result() -> Result<Local, ()> { Ok(Local) }
fn optional() -> Option<Local> { Some(Local) }
fn tuple() -> Option<(&'static str, Local)> { Some(("item", Local)) }
fn foreign_option() -> Option<Other> { Some(Other) }
fn aliased() -> AppResult<Local> { Ok(Local) }
fn swapped() -> contracts::Swapped<Local, Other> { Ok(Other) }
pub struct Builder;
impl Builder {
    fn create() -> Self { Builder }
    fn build(self) -> AppResult<Local> { Ok(Local) }
}
fn standard_result() {
    let r = result();
    let m = r.unwrap();
    m.ping();
}
fn receiver_alias(seed: &Local) {
    let mut item = seed;
    item = seed;
    item.ping();
}
fn reborrowed(seed: &mut Local) {
    let item = &*seed;
    item.ping();
}
struct Wrapper(Other);
impl std::ops::Deref for Wrapper {
    type Target = Other;
    fn deref(&self) -> &Other { &self.0 }
}
fn overloaded_deref(seed: Wrapper) {
    let item = &*seed;
    item.ping();
}
fn alias_shadow(seed: &Local, other: &Other) {
    let item = seed;
    let item = other;
    item.ping();
}
fn alias_unknown<T: Has>(seed: &T) {
    let item = seed;
    item.ping();
}
fn standard_option() {
    let r = optional();
    let m = r.expect("present");
    m.ping();
}
fn pattern_option() {
    if let Some(item) = optional() { item.ping(); }
}
fn pattern_let_else() {
    let Some(item) = optional() else { return; };
    item.ping();
}
fn pattern_tuple() {
    match tuple() {
        Some((_, ref item)) => item.ping(),
        None => (),
    }
}
fn pattern_while() {
    while let Some(item) = optional() { item.ping(); break; }
}
fn pattern_macro() {
    if let Some(item) = optional() { assert!(item.ready()); }
}
fn generic_optional<T: Default>() -> Option<T> { Some(T::default()) }
fn pattern_unknown<T: Default + Has>() {
    if let Some(item) = generic_optional::<T>() { item.ping(); }
}
fn pattern_foreign() {
    if let Some(item) = foreign_option() { item.ping(); }
}
fn pattern_shadow() {
    if let Some(item) = optional() {
        let item = Other;
        item.ping();
    }
}
fn imported_alias() {
    let r = aliased();
    let m = r.unwrap();
    m.ping();
}
fn builder_chain() {
    let r = Builder::create().build();
    let m = r.unwrap();
    m.ping();
}
fn shadowed_variable(replacement: Result<Other, ()>) {
    let r = result();
    let r = replacement;
    let m = r.unwrap();
    m.ping();
}
fn different_payload() {
    let r = swapped();
    let m = r.unwrap();
    m.ping();
}
fn custom_wrapper() {
    let r = fake::make();
    let m = r.unwrap();
    m.ping();
}
fn guessed_constructor() {
    let r = Local::new();
    let m = r.produce();
    let value = m.unwrap();
    value.ping();
}
fn unresolved<T: Has>(r: Result<T, ()>) {
    let m = r.unwrap();
    m.ping();
}
struct Holder { inner: Local, values: Vec<Local> }
impl Holder {
    fn entries(&self) -> impl Iterator<Item = &Local> { self.values.iter() }
    fn visit_loop(&self) {
        for item in self.entries() { item.ping(); }
    }
    fn closure_chain(&self) {
        self.entries().for_each(|item| item.child().ping());
    }
    fn field_in_macro(&self, inner: Other) {
        assert!(self.inner.ready());
    }
}
