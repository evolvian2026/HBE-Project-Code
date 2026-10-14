/**
 * The platform's static analysis rules (Semgrep), for the mistakes student web apps make most:
 * injection, code from strings, hard-coded secrets, weak hashing, unsafe HTML and switched-off
 * security checks. Each rule is one test on the run page; its severity is its weight
 * (ERROR 3, WARNING 2, INFO 1). The harness writes them as a Semgrep config file (JSON is
 * YAML) and runs Semgrep offline. Changing them changes grades: add rules with care, check
 * them against the starter templates (they must stay clean), and note them in the changelog.
 */
const JS = ["javascript", "typescript"];

export const SEMGREP_RULES = [
  {
    id: "js-eval",
    languages: JS,
    severity: "ERROR",
    message: "code is built from a string at run time.",
    metadata: {
      title: "No eval() or new Function()",
      category: "Security",
      fix: "Don't run strings as code: parse data with JSON.parse, and look functions up in an object instead.",
    },
    "pattern-either": [{ pattern: "eval(...)" }, { pattern: "new Function(...)" }],
  },
  {
    id: "js-shell-injection",
    languages: JS,
    severity: "ERROR",
    message: "a shell command is built from values that may come from users.",
    metadata: {
      title: "No shell commands built from input",
      category: "Security",
      fix: "Use execFile or spawn with an array of arguments instead of exec with a command string.",
    },
    // Only child_process's exec (not RegExp.prototype.exec).
    patterns: [
      {
        "pattern-either": [
          {
            patterns: [
              {
                "pattern-either": [
                  { pattern: "$CP.$EXEC(`...${$X}...`, ...)" },
                  { pattern: "$CP.$EXEC($A + $B, ...)" },
                ],
              },
              {
                "pattern-either": [
                  { "pattern-inside": 'import $CP from "$MOD";\n...' },
                  { "pattern-inside": 'import * as $CP from "$MOD";\n...' },
                  { "pattern-inside": '$CP = require("$MOD");\n...' },
                ],
              },
            ],
          },
          {
            patterns: [
              { "pattern-either": [{ pattern: "$EXEC(`...${$X}...`, ...)" }, { pattern: "$EXEC($A + $B, ...)" }] },
              {
                "pattern-either": [
                  { "pattern-inside": 'import { ..., $EXEC, ... } from "$MOD";\n...' },
                  { "pattern-inside": 'const { ..., $EXEC, ... } = require("$MOD");\n...' },
                ],
              },
            ],
          },
        ],
      },
      { "metavariable-regex": { metavariable: "$EXEC", regex: "^(exec|execSync)$" } },
      { "metavariable-regex": { metavariable: "$MOD", regex: "^(node:)?child_process$" } },
    ],
  },
  {
    id: "js-sql-injection",
    languages: JS,
    severity: "ERROR",
    message: "an SQL query is built by pasting values into the text.",
    metadata: {
      title: "No SQL built by string concatenation",
      category: "Security",
      fix: "Pass values as query parameters (e.g. db.query('select … where id = $1', [id])).",
    },
    patterns: [
      {
        "pattern-either": [
          { pattern: "$DB.$METHOD(`...${$X}...`, ...)" },
          { pattern: '$DB.$METHOD("..." + $X, ...)' },
          { pattern: '$DB.$METHOD($X + "...", ...)' },
        ],
      },
      { "metavariable-regex": { metavariable: "$METHOD", regex: "^(query|execute|raw|unsafe|\\$queryRawUnsafe)$" } },
    ],
  },
  {
    id: "js-hardcoded-jwt-secret",
    languages: JS,
    severity: "ERROR",
    message: "a JWT is signed or checked with a secret written in the code.",
    metadata: {
      title: "No hard-coded JWT secret",
      category: "Security",
      fix: "Read the secret from an environment variable (e.g. process.env.JWT_SECRET) and keep it out of the repository.",
    },
    patterns: [
      { "pattern-either": [{ pattern: '$JWT.sign($P, "...", ...)' }, { pattern: '$JWT.verify($T, "...", ...)' }] },
      { "metavariable-regex": { metavariable: "$JWT", regex: "(?i)jwt|jsonwebtoken" } },
    ],
  },
  {
    id: "js-unsafe-html",
    languages: JS,
    severity: "WARNING",
    message: "HTML is built from data, which can let users inject scripts.",
    metadata: {
      title: "No HTML injected from data",
      category: "Security",
      fix: "Set textContent instead of innerHTML, and let React render values instead of dangerouslySetInnerHTML.",
    },
    "pattern-either": [
      { patterns: [{ pattern: "$EL.innerHTML = $X" }, { "pattern-not": '$EL.innerHTML = "..."' }] },
      { patterns: [{ pattern: "$EL.outerHTML = $X" }, { "pattern-not": '$EL.outerHTML = "..."' }] },
      { patterns: [{ pattern: "{__html: $X}" }, { "pattern-not": '{__html: "..."}' }] },
      { pattern: "document.write(...)" },
    ],
  },
  {
    id: "js-weak-hash",
    languages: JS,
    severity: "WARNING",
    message: "MD5 or SHA-1 is used.",
    metadata: {
      title: "No MD5 or SHA-1 hashing",
      category: "Security",
      fix: "Hash passwords with bcrypt, scrypt or argon2, and use SHA-256 or better for anything else.",
    },
    patterns: [
      { pattern: "$C.createHash($ALG)" },
      { "metavariable-regex": { metavariable: "$ALG", regex: "^['\"`](md5|sha1)['\"`]$" } },
    ],
  },
  {
    id: "js-tls-verification-off",
    languages: JS,
    severity: "WARNING",
    message: "TLS certificate checks are turned off.",
    metadata: {
      title: "TLS certificates are checked",
      category: "Security",
      fix: "Remove rejectUnauthorized: false and NODE_TLS_REJECT_UNAUTHORIZED; fix the certificate instead.",
    },
    "pattern-either": [
      { pattern: "{..., rejectUnauthorized: false, ...}" },
      { pattern: "process.env.NODE_TLS_REJECT_UNAUTHORIZED = $X" },
    ],
  },
  {
    id: "py-eval",
    languages: ["python"],
    severity: "ERROR",
    message: "code is built from a string at run time.",
    metadata: {
      title: "No eval() or exec()",
      category: "Security",
      fix: "Don't run strings as code: parse data with json.loads or ast.literal_eval.",
    },
    "pattern-either": [{ pattern: "eval(...)" }, { pattern: "exec(...)" }],
  },
  {
    id: "py-sql-injection",
    languages: ["python"],
    severity: "ERROR",
    message: "an SQL query is built by pasting values into the text.",
    metadata: {
      title: "No SQL built by string formatting",
      category: "Security",
      fix: "Pass values as query parameters (cursor.execute('… where id = %s', [id])) or use the ORM.",
    },
    patterns: [
      {
        "pattern-either": [
          { pattern: '$C.$METHOD(f"...", ...)' },
          { pattern: '$C.$METHOD("..." % $X, ...)' },
          { pattern: '$C.$METHOD("...".format(...), ...)' },
          { pattern: '$C.$METHOD("..." + $X, ...)' },
        ],
      },
      { "metavariable-regex": { metavariable: "$METHOD", regex: "^(execute|executemany|raw|executescript)$" } },
    ],
  },
  {
    id: "py-shell-injection",
    languages: ["python"],
    severity: "ERROR",
    message: "a shell runs a command that may contain values from users.",
    metadata: {
      title: "No shell commands built from input",
      category: "Security",
      fix: "Call subprocess.run with a list of arguments and without shell=True.",
    },
    "pattern-either": [
      { pattern: "subprocess.$F(..., shell=True, ...)" },
      { patterns: [{ pattern: "os.system($X)" }, { "pattern-not": 'os.system("...")' }] },
      { patterns: [{ pattern: "os.popen($X, ...)" }, { "pattern-not": 'os.popen("...", ...)' }] },
    ],
  },
  {
    id: "py-hardcoded-secret-key",
    languages: ["python"],
    severity: "ERROR",
    message: "the secret key is written in the code.",
    metadata: {
      title: "No hard-coded secret key",
      category: "Security",
      fix: "Read SECRET_KEY from an environment variable (os.environ['SECRET_KEY']).",
    },
    pattern: 'SECRET_KEY = "..."',
  },
  {
    id: "py-debug-on",
    languages: ["python"],
    severity: "WARNING",
    message: "debug mode is always on.",
    metadata: {
      title: "Debug mode is not always on",
      category: "Security",
      fix: "Turn DEBUG on only from an environment variable used on your computer, never in production.",
    },
    "pattern-either": [{ pattern: "DEBUG = True" }, { pattern: "$APP.run(..., debug=True, ...)" }],
  },
  {
    id: "py-unsafe-deserialization",
    languages: ["python"],
    severity: "WARNING",
    message: "data is loaded in a way that can run code.",
    metadata: {
      title: "No pickle or unsafe YAML loading",
      category: "Security",
      fix: "Use json for data from users, and yaml.safe_load instead of yaml.load.",
    },
    "pattern-either": [
      { pattern: "pickle.loads(...)" },
      { pattern: "pickle.load(...)" },
      {
        patterns: [
          { pattern: "yaml.load(...)" },
          { "pattern-not": "yaml.load(..., Loader=yaml.SafeLoader, ...)" },
          { "pattern-not": "yaml.load(..., Loader=yaml.CSafeLoader, ...)" },
        ],
      },
    ],
  },
  {
    id: "py-weak-hash",
    languages: ["python"],
    severity: "WARNING",
    message: "MD5 or SHA-1 is used.",
    metadata: {
      title: "No MD5 or SHA-1 hashing",
      category: "Security",
      fix: "Use Django's password hashers (or bcrypt/argon2) for passwords, and hashlib.sha256 for anything else.",
    },
    "pattern-either": [
      { pattern: "hashlib.md5(...)" },
      { pattern: "hashlib.sha1(...)" },
      { pattern: 'hashlib.new("md5", ...)' },
      { pattern: 'hashlib.new("sha1", ...)' },
    ],
  },
  {
    id: "py-tls-verification-off",
    languages: ["python"],
    severity: "WARNING",
    message: "TLS certificate checks are turned off.",
    metadata: {
      title: "TLS certificates are checked",
      category: "Security",
      fix: "Remove verify=False; fix the certificate instead.",
    },
    pattern: "requests.$M(..., verify=False, ...)",
  },
];

/** The Semgrep config file's contents (JSON, which Semgrep reads as YAML). */
export function semgrepConfig(rules = SEMGREP_RULES) {
  return JSON.stringify({ rules });
}
