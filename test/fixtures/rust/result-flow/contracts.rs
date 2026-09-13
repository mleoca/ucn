use std::result::Result as Standard;
pub type Outcome<T, E = ()> = Standard<T, E>;
pub type Swapped<E, T> = Standard<T, E>;

pub fn make() -> crate::Local { crate::Local }
pub fn generic<T: Default>() -> T { T::default() }
