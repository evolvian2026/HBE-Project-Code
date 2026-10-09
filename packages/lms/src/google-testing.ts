/**
 * A stand-in for Google's OAuth and Classroom APIs (tests only): consent is automatic for the
 * person `signInAs` names, tokens are opaque strings, and classes, coursework and student
 * submissions live in memory where tests can inspect and change them.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { UnsecuredJWT } from "jose";
import type { GoogleEndpoints } from "./google.ts";

export interface FakeGoogleUser {
  sub: string;
  email: string;
}

export interface FakeClass {
  id: string;
  name: string;
  section?: string;
  teacherSub: string;
  students: { userId: string; email: string; name?: string }[];
}

export interface FakeCourseWork {
  id: string;
  courseId: string;
  title: string;
  description: string;
  maxPoints: number;
  materials: unknown[];
  dueDate?: { year: number; month: number; day: number };
  dueTime?: { hours: number; minutes: number };
}

export interface FakeSubmission {
  id: string;
  courseId: string;
  courseWorkId: string;
  userId: string;
  state: "CREATED" | "TURNED_IN" | "RETURNED";
  assignedGrade?: number;
  draftGrade?: number;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => resolve(raw));
  });

export class FakeGoogle {
  private server: Server | null = null;
  url = "";
  readonly clientId = "fake-google-client";
  readonly clientSecret = "fake-google-secret";
  /** Who consents at the next authorization request. */
  signInAs: FakeGoogleUser | null = null;
  readonly classes = new Map<string, FakeClass>();
  readonly courseWork = new Map<string, FakeCourseWork>();
  readonly submissions = new Map<string, FakeSubmission>();
  private readonly codes = new Map<string, { user: FakeGoogleUser; challenge: string; redirectUri: string }>();
  private readonly refreshTokens = new Map<string, FakeGoogleUser>();
  private readonly accessTokens = new Map<string, FakeGoogleUser>();
  /** Every grade patch, in order. */
  readonly grades: { submissionId: string; assignedGrade: number }[] = [];
  /** Page size of list responses (tests pagination). */
  pageSize = 2;

  static async serve(port = 0): Promise<FakeGoogle> {
    const g = new FakeGoogle();
    g.server = createServer((req, res) => {
      void g.handle(req).then(
        ({ status, body, location }) => {
          if (location) res.writeHead(status, { location }).end();
          else res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
        },
        (err: Error) => res.writeHead(500).end(err.message),
      );
    });
    await new Promise<void>((resolve) => g.server!.listen(port, "127.0.0.1", resolve));
    g.url = `http://127.0.0.1:${(g.server.address() as { port: number }).port}`;
    return g;
  }

  get endpoints(): GoogleEndpoints {
    return { authUrl: `${this.url}/auth`, tokenUrl: `${this.url}/token`, apiUrl: this.url };
  }

  close(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  addClass(c: Omit<FakeClass, "students"> & { students?: FakeClass["students"] }): FakeClass {
    const full = { students: [], ...c };
    this.classes.set(c.id, full);
    return full;
  }

  /** The person revokes the platform's access in their Google account. */
  revoke(sub: string): void {
    for (const [token, user] of this.refreshTokens) if (user.sub === sub) this.refreshTokens.delete(token);
    for (const [token, user] of this.accessTokens) if (user.sub === sub) this.accessTokens.delete(token);
  }

  private page<T>(items: T[], url: URL, key: string) {
    const start = Number(url.searchParams.get("pageToken") ?? "0");
    const next = start + this.pageSize < items.length ? String(start + this.pageSize) : undefined;
    return { [key]: items.slice(start, start + this.pageSize), ...(next ? { nextPageToken: next } : {}) };
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body?: unknown; location?: string }> {
    const url = new URL(req.url ?? "/", this.url);

    if (url.pathname === "/auth") {
      if (!this.signInAs) return { status: 400, body: { error: "nobody to sign in as" } };
      if (url.searchParams.get("client_id") !== this.clientId)
        return { status: 400, body: { error: "invalid_client" } };
      const code = `code-${randomUUID()}`;
      const redirectUri = url.searchParams.get("redirect_uri")!;
      this.codes.set(code, {
        user: this.signInAs,
        challenge: url.searchParams.get("code_challenge") ?? "",
        redirectUri,
      });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      return { status: 302, location: back.toString() };
    }

    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("client_id") !== this.clientId || form.get("client_secret") !== this.clientSecret) {
        return { status: 401, body: { error: "invalid_client" } };
      }
      const issueAccess = (user: FakeGoogleUser) => {
        const token = `access-${randomUUID()}`;
        this.accessTokens.set(token, user);
        return token;
      };
      if (form.get("grant_type") === "authorization_code") {
        const grant = this.codes.get(form.get("code") ?? "");
        this.codes.delete(form.get("code") ?? "");
        const challenge = createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url");
        if (!grant || grant.challenge !== challenge || grant.redirectUri !== form.get("redirect_uri")) {
          return { status: 400, body: { error: "invalid_grant" } };
        }
        const refresh = `refresh-${randomUUID()}`;
        this.refreshTokens.set(refresh, grant.user);
        const idToken = new UnsecuredJWT({ email: grant.user.email, email_verified: true })
          .setSubject(grant.user.sub)
          .setIssuer("https://accounts.google.com")
          .setAudience(this.clientId)
          .setIssuedAt()
          .setExpirationTime("1h")
          .encode();
        return {
          status: 200,
          body: {
            access_token: issueAccess(grant.user),
            refresh_token: refresh,
            id_token: idToken,
            expires_in: 3599,
            token_type: "Bearer",
            scope: "openid email https://www.googleapis.com/auth/classroom.coursework.students",
          },
        };
      }
      if (form.get("grant_type") === "refresh_token") {
        const user = this.refreshTokens.get(form.get("refresh_token") ?? "");
        if (!user) return { status: 400, body: { error: "invalid_grant" } };
        return { status: 200, body: { access_token: issueAccess(user), expires_in: 3599, token_type: "Bearer" } };
      }
      return { status: 400, body: { error: "unsupported_grant_type" } };
    }

    const user = this.accessTokens.get(/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "");
    if (!user) return { status: 401, body: { error: { message: "Request had invalid authentication credentials." } } };
    const forbidden = { status: 403, body: { error: { message: "The caller does not have permission" } } };

    if (url.pathname === "/v1/courses" && req.method === "GET") {
      const mine = [...this.classes.values()]
        .filter((c) => c.teacherSub === user.sub)
        .map((c) => ({
          id: c.id,
          name: c.name,
          section: c.section,
          courseState: "ACTIVE",
          alternateLink: `${this.url}/c/${c.id}`,
        }));
      return { status: 200, body: this.page(mine, url, "courses") };
    }

    const course = /^\/v1\/courses\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const c = course ? this.classes.get(decodeURIComponent(course[1]!)) : undefined;
    if (!course || !c) return { status: 404, body: { error: { message: "Requested entity was not found." } } };
    if (c.teacherSub !== user.sub) return forbidden;
    const rest = course[2] ?? "";

    if (rest === "/students" && req.method === "GET") {
      const students = c.students.map((s) => ({
        userId: s.userId,
        profile: { id: s.userId, emailAddress: s.email, name: { fullName: s.name ?? s.email } },
      }));
      return { status: 200, body: this.page(students, url, "students") };
    }

    if (rest === "/courseWork" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as Omit<FakeCourseWork, "id" | "courseId">;
      const work: FakeCourseWork = { ...body, id: `cw-${this.courseWork.size + 1}`, courseId: c.id };
      this.courseWork.set(work.id, work);
      for (const s of c.students) {
        const id = `sub-${this.submissions.size + 1}`;
        this.submissions.set(id, { id, courseId: c.id, courseWorkId: work.id, userId: s.userId, state: "CREATED" });
      }
      return { status: 200, body: { ...work, alternateLink: `${this.url}/c/${c.id}/a/${work.id}` } };
    }

    const subs = /^\/courseWork\/([^/]+)\/studentSubmissions(?:\/([^/:]+)(:return)?)?$/.exec(rest);
    if (subs) {
      const work = this.courseWork.get(decodeURIComponent(subs[1]!));
      if (!work || work.courseId !== c.id) return { status: 404, body: { error: { message: "No such coursework." } } };
      if (!subs[2] && req.method === "GET") {
        const userId = url.searchParams.get("userId");
        const list = [...this.submissions.values()].filter(
          (s) => s.courseWorkId === work.id && (!userId || s.userId === userId),
        );
        return { status: 200, body: this.page(list, url, "studentSubmissions") };
      }
      const submission = this.submissions.get(decodeURIComponent(subs[2] ?? ""));
      if (!submission || submission.courseWorkId !== work.id) {
        return { status: 404, body: { error: { message: "No such submission." } } };
      }
      if (subs[3] && req.method === "POST") {
        submission.state = "RETURNED";
        return { status: 200, body: {} };
      }
      if (req.method === "PATCH") {
        const patch = JSON.parse(await readBody(req)) as { assignedGrade?: number; draftGrade?: number };
        const mask = (url.searchParams.get("updateMask") ?? "").split(",");
        if (mask.includes("assignedGrade") && patch.assignedGrade !== undefined) {
          if (patch.assignedGrade > work.maxPoints)
            return { status: 400, body: { error: { message: "Grade too high." } } };
          submission.assignedGrade = patch.assignedGrade;
          this.grades.push({ submissionId: submission.id, assignedGrade: patch.assignedGrade });
        }
        if (mask.includes("draftGrade") && patch.draftGrade !== undefined) submission.draftGrade = patch.draftGrade;
        return { status: 200, body: submission };
      }
    }
    return { status: 404, body: { error: { message: "Not found." } } };
  }
}
