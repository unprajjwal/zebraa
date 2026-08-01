use std::error::Error;

/// Renders an error together with its full `source()` chain.
///
/// Several database errors carry no detail in their own `Display` impl — notably
/// `tokio_postgres::Error`, which prints only `"db error"` and keeps the server's
/// actual message (`DbError`) in its source. Wrapping those in a pool adds another
/// opaque layer (`"Error occurred while creating a new object: db error"`), so
/// calling `.to_string()` alone loses everything the user needs to fix the problem.
pub fn describe_error<E: Error + ?Sized>(err: &E) -> String {
    let mut parts = vec![err.to_string()];
    let mut source = err.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !text.is_empty() && !parts.iter().any(|p| p == &text) {
            parts.push(text);
        }
        source = cause.source();
    }
    parts.join(": ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt;

    #[derive(Debug)]
    struct Leaf(&'static str);
    impl fmt::Display for Leaf {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str(self.0)
        }
    }
    impl Error for Leaf {}

    #[derive(Debug)]
    struct Wrapper(Leaf);
    impl fmt::Display for Wrapper {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("db error")
        }
    }
    impl Error for Wrapper {
        fn source(&self) -> Option<&(dyn Error + 'static)> {
            Some(&self.0)
        }
    }

    #[test]
    fn includes_source_detail() {
        let err = Wrapper(Leaf("password authentication failed for user \"bob\""));
        assert_eq!(
            describe_error(&err),
            "db error: password authentication failed for user \"bob\""
        );
    }

    #[test]
    fn deduplicates_repeated_messages() {
        let err = Leaf("boom");
        assert_eq!(describe_error(&err), "boom");
    }
}
