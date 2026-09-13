pub struct Result<T>(T);
impl<T> Result<T> {
    pub fn unwrap(self) -> crate::Other { crate::Other }
}
pub fn make() -> Result<crate::Local> { Result(crate::Local) }
// An unrelated same-name project type must not erase prelude Option flow.
pub struct Option<T>(pub T);
