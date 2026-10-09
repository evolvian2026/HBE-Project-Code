# Starter templates

One starter repository per global stack profile. Each meets its profile's contract (the files it
expects, the services, ports and health URLs, and the lint and test commands), so a student's
first push already builds, starts and passes lint and their own tests.

| Folder | Stack profile | Services | Lint | Student tests |
|--------|---------------|----------|------|---------------|
| `node22-api` | `node22-api` | `backend` :4000 | ESLint | `node:test` → `junit.xml` |
| `mern-node20` | `mern-node20` | `frontend` :3000 (nginx, React), `backend` :4000 (Express, MongoDB) | ESLint (both) | `node:test` → `backend/junit.xml` |
| `django-react` | `django-react` | `frontend` :3000 (nginx, React), `backend` :8000 (Django REST, PostgreSQL) | Ruff | `manage.py test` |

The MERN and Django templates share the same example (a notes API and page);
`grader/suites/sample/starter-notes` is a hidden suite for it, and a starting point for an
assignment's own.

## Publishing a template

Assignments name a template repository on GitHub (`owner/name`); the platform creates each
student's repository from it. Publish a folder as a private template repository in the GitHub
organization the platform's App is installed on (or any organization the App can read):

```bash
scripts/publish-template.sh templates/mern-node20 my-org/mern-starter
```

The script needs the GitHub CLI (`gh`) signed in as someone who can create repositories there.
It creates the repository, pushes the folder as its first commit and marks it as a template.
Change a template by pushing to that repository; repositories already created from it don't
change.

`grader/test/templates.docker.test.mjs` grades every template with the real harness (CI job
"Starter templates").
