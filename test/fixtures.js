export const APP_DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -10,4 +10,5 @@ export function handler(req) {',
  '   const id = req.params.id;',
  '-  const user = db.get(id);',
  '+  const user = await db.get(id);',
  '+  if (!user) return null;',
  '   return user.name;',
  ' }',
].join('\n');

export const DELETED_DIFF = [
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  'index 3333333..0000000',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-line one',
  '-line two',
].join('\n');

export const BINARY_DIFF = [
  'diff --git a/logo.png b/logo.png',
  'index 4444444..5555555 100644',
  'Binary files a/logo.png and b/logo.png differ',
].join('\n');

export const RENAME_DIFF = [
  'diff --git a/a/b.js b/c/d.js',
  'similarity index 90%',
  'rename from a/b.js',
  'rename to c/d.js',
  'index 6666666..7777777 100644',
  '--- a/a/b.js',
  '+++ b/c/d.js',
  '@@ -1,3 +1,3 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  ' const c = 4;',
].join('\n');

export const ADDED_DIFF = [
  'diff --git a/new.js b/new.js',
  'new file mode 100644',
  'index 0000000..8888888',
  '--- /dev/null',
  '+++ b/new.js',
  '@@ -0,0 +1,2 @@',
  '+export const x = 1;',
  '+export const y = 2;',
  '\\ No newline at end of file',
].join('\n');

/** 20-line file matching APP_DIFF's post-image around the hunk. */
export const APP_CONTENT = Array.from({ length: 20 }, (_, i) => {
  const n = i + 1;
  if (n === 11) return '  const user = await db.get(id);';
  if (n === 12) return '  if (!user) return null;';
  return `line ${n}`;
}).join('\n');

export const CONFIG = {
  contextLines: 3,
  chunkTokens: 30000,
  maxInputTokens: 120000,
  maxFiles: 60,
  ignore: [],
};
