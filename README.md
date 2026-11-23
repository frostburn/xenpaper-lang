# Xenpaper language history

The Git bundle on this branch contains the complete history of the `xenpaper-lang/` directory through [Xenpaper 3 commit 0f63c46](https://github.com/frostburn/xenpaper3/tree/0f63c461cc1c6163d9c6271ec48bc8a714a70cbe/xenpaper-lang). It holds 130 commits with their original author, date, and message. Paths start at the language directory.

From a clone of this repository, import the archive into a local branch and inspect any file’s history.

```sh
git fetch origin setup/import-language-history
git show FETCH_HEAD:xenpaper-lang-history.bundle > xenpaper-lang-history.bundle
git bundle verify xenpaper-lang-history.bundle
git fetch ./xenpaper-lang-history.bundle upstream-language:refs/heads/upstream-language
git log upstream-language -- runtime/pitches.ts
```

The filtered tip is `ad43c83e39b2ff590b1ac492f442e773f6624c60` and its tree is `f896be4686769e9ac6d23b33f540016b8e62e866`. To reproduce that tip in a Xenpaper 3 clone, run `git subtree split --prefix=xenpaper-lang 0f63c461cc1c6163d9c6271ec48bc8a714a70cbe`.
