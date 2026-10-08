# HBE Project Platform

An automated full-stack project evaluation and management platform for students and educators,
serving **multiple institutions** from one deployment.

- **Students** work in GitHub repositories provisioned per assignment, in the tech stack the
  teacher chose for that project. Every push or pull request can trigger an automated build and
  test pipeline, with detailed, actionable failure feedback.
- **Educators** track commit, PR and issue activity (which counts toward the grade as a
  process score), review code, score rubrics, and release targeted feedback and grades.
  Grades are pushed to **Canvas, Moodle or Google Classroom**.
- **Every submission and grade report is archived** (for the contract plus 2 years), so a
  student's performance history can be reviewed at any time.
- **Institution admins** manage users (students, teachers, admins), courses, stack profiles,
  GitHub and LMS connections, and settings. A **super admin** manages institutions.

**Stack:** Next.js · Fastify · pg-boss · Supabase (Postgres, Auth, Storage, Realtime) · GitHub App +
GitHub Actions (isolated grading) · LTI 1.3 / Google Classroom API.

**Hosting (Singapore):** free tiers for the demo (Render + Supabase), then AWS EC2 ap-southeast-1
with Supabase Pro. The same Docker image and hostnames are used in both.

## Design documents

| Doc | Contents |
|-----|----------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, components, GitHub integration, evaluation pipeline, security, deployment, custom domain |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | Functional and non-functional requirements, tech stack, setup checklist, decisions log |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Database schema, RLS patterns, indexes |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Free-tier demo setup, AWS EC2 production design, runners, migration runbook |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phased delivery plan and key risks |
