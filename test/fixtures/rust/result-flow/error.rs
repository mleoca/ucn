pub struct Error<F = ()>(std::marker::PhantomData<F>);
impl<F> Error<F> {
    pub fn build() -> Self { Self(std::marker::PhantomData) }
    pub fn message(&self) -> bool { true }
}
