# HBE Project Platform

An automated full-stack project evaluation and management platform for students and educators.

- **Students** work in GitHub repositories provisioned per assignment. Every push or pull request
  can trigger an automated build and test pipeline against their full-stack app.
- **Educators** track commit, PR and issue activity, review code, score rubrics, and release
  targeted feedback and grades.
- **Admins** manage users (students, teachers, admins), courses, project assignments, GitHub
  integration and platform settings.

**Stack:** Next.js · Fastify · BullMQ · Supabase (Postgres, Auth, Storage, Realtime) · GitHub App +
GitHub Actions (isolated grading) · Render (hosting, custom domain).

## Design documents

| Doc | Contents |
|-----|----------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, components, GitHub integration, evaluation pipeline, security, deployment, custom domain |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | Functional and non-functional requirements, tech stack, setup checklist, open questions |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Database schema, RLS patterns, indexes |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phased delivery plan and key risks |
