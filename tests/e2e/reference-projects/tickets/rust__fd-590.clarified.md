# Do not exit immediately if one of the search paths is missing

When several search paths are given and some of them don't exist or aren't directories, fd stops with an error before searching anything.

Expected:
- Search every path that is a directory and print the results as usual.
- For each path that isn't a directory, print the existing error, unchanged: `[fd error]: Search path 'fake' is not a directory.` One line per such path, in the order given, then keep going.
- If at least one path is valid, exit successfully (code 0), even though some were skipped.
- If no path is valid, print the error for each one, then `[fd error]: No valid search paths given.`, and exit with a non-zero code.

Examples, with a directory `real` that contains `a.foo` and `b.foo`:

```
$ fd a.foo real fake
real/a.foo
[fd error]: Search path 'fake' is not a directory.        (stderr)
-> exit code 0

$ fd '' real fake1 fake2
real/a.foo
real/b.foo
[fd error]: Search path 'fake1' is not a directory.
[fd error]: Search path 'fake2' is not a directory.
-> exit code 0

$ fd '' fake1 fake2
[fd error]: Search path 'fake1' is not a directory.
[fd error]: Search path 'fake2' is not a directory.
[fd error]: No valid search paths given.
-> non-zero exit code
```
