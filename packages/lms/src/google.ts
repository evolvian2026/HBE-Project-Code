import { createHash, randomBytes } from "node:crypto";
import { decodeJwt } from "jose";

/** Google's OAuth and Classroom endpoints (a stand-in's, in local tests). */
export interface GoogleEndpoints {
  authUrl: string;
  tokenUrl: string;
  apiUrl: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  apiUrl: "https://classroom.googleapis.com",
};

/** Everything a teacher's consent covers: their classes, rosters (with emails) and coursework. */
export const CLASSROOM_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.rosters.readonly",
  "https://www.googleapis.com/auth/classroom.profile.emails",
  "https://www.googleapis.com/auth/classroom.coursework.students",
];

export class GoogleError extends Error {
  constructor(
    readonly code: "auth_revoked" | "auth_failed" | "api_failed" | "not_found",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GoogleError";
  }
}

/** A PKCE verifier and its S256 challenge. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Where to send the teacher to grant access (offline, so a refresh token comes back). */
export function authorizationUrl(
  ep: GoogleEndpoints,
  o: { clientId: string; redirectUri: string; state: string; codeChallenge: string; loginHint?: string | null },
): string {
  const url = new URL(ep.authUrl);
  url.search = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: "code",
    scope: CLASSROOM_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: o.state,
    code_challenge: o.codeChallenge,
    code_challenge_method: "S256",
    ...(o.loginHint ? { login_hint: o.loginHint } : {}),
  }).toString();
  return url.toString();
}

export interface GoogleGrant {
  refreshToken: string;
  scopes: string[];
  googleUserId: string;
  email: string | null;
}

/**
 * Exchanges the authorization code (with the PKCE verifier) for tokens. The id_token comes
 * straight from Google's token endpoint over TLS, so its claims are read without checking
 * its signature (OpenID Connect Core §3.1.3.7).
 */
export async function exchangeCode(
  ep: GoogleEndpoints,
  o: { clientId: string; clientSecret: string; code: string; redirectUri: string; codeVerifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleGrant> {
  const res = await fetchImpl(ep.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: o.code,
      redirect_uri: o.redirectUri,
      client_id: o.clientId,
      client_secret: o.clientSecret,
      code_verifier: o.codeVerifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => null)) as {
    refresh_token?: string;
    id_token?: string;
    scope?: string;
    error?: string;
  } | null;
  if (!res.ok || !body?.id_token) {
    throw new GoogleError("auth_failed", `Google refused the sign-in (${body?.error ?? `HTTP ${res.status}`}).`);
  }
  if (!body.refresh_token) {
    throw new GoogleError("auth_failed", "Google didn't grant offline access. Try connecting again.");
  }
  const claims = decodeJwt(body.id_token);
  if (!claims.sub) throw new GoogleError("auth_failed", "Google didn't say who signed in.");
  return {
    refreshToken: body.refresh_token,
    scopes: (body.scope ?? "").split(" ").filter(Boolean),
    googleUserId: claims.sub,
    email: typeof claims.email === "string" ? claims.email.toLowerCase() : null,
  };
}

export interface ClassroomCourse {
  id: string;
  name: string;
  section: string | null;
  alternateLink: string | null;
}

export interface ClassroomStudent {
  userId: string;
  email: string | null;
  name: string | null;
}

export interface StudentSubmission {
  id: string;
  userId: string;
  state: string;
  assignedGrade: number | null;
  draftGrade: number | null;
}

const MAX_PAGES = 100;

/** Google Classroom as one teacher (their refresh token), for one institution. */
export class ClassroomClient {
  private access: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly ep: GoogleEndpoints,
    private readonly creds: { clientId: string; clientSecret: string; refreshToken: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async token(): Promise<string> {
    if (this.access && this.access.expiresAt > Date.now() + 60_000) return this.access.token;
    const res = await this.fetchImpl(this.ep.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.creds.refreshToken,
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    } | null;
    if (body?.error === "invalid_grant") {
      throw new GoogleError("auth_revoked", "The teacher's Google connection has expired or was revoked.", res.status);
    }
    if (!res.ok || !body?.access_token) {
      throw new GoogleError("auth_failed", `Google refused an access token (${body?.error ?? `HTTP ${res.status}`}).`);
    }
    this.access = { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
    return body.access_token;
  }

  private async call<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.ep.apiUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.token()}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const detail = ((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message;
      throw new GoogleError(
        res.status === 404 ? "not_found" : "api_failed",
        `Google Classroom answered HTTP ${res.status} to ${method} ${path}${detail ? `: ${detail}` : ""}`,
        res.status,
      );
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  private async pages<T>(path: string, key: string): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const body = await this.call<Record<string, unknown>>(
        "GET",
        `${path}${pageToken ? `${sep}pageToken=${encodeURIComponent(pageToken)}` : ""}`,
      );
      out.push(...((body[key] as T[] | undefined) ?? []));
      pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
      if (!pageToken) break;
    }
    return out;
  }

  /** The active classes this teacher teaches. */
  async courses(): Promise<ClassroomCourse[]> {
    const list = await this.pages<Record<string, unknown>>("/v1/courses?teacherId=me&courseStates=ACTIVE", "courses");
    return list.map((c) => ({
      id: String(c.id),
      name: String(c.name ?? c.id),
      section: typeof c.section === "string" ? c.section : null,
      alternateLink: typeof c.alternateLink === "string" ? c.alternateLink : null,
    }));
  }

  async students(courseId: string): Promise<ClassroomStudent[]> {
    const list = await this.pages<{
      userId: string;
      profile?: { emailAddress?: string; name?: { fullName?: string } };
    }>(`/v1/courses/${encodeURIComponent(courseId)}/students`, "students");
    return list.map((s) => ({
      userId: s.userId,
      email: s.profile?.emailAddress?.toLowerCase() ?? null,
      name: s.profile?.name?.fullName ?? null,
    }));
  }

  /** Creates the assignment in the class (Classroom only takes grades for coursework the platform made). */
  async createCourseWork(
    courseId: string,
    work: { title: string; description: string; link: string; maxPoints: number; due: Date | null },
  ): Promise<{ id: string; alternateLink: string | null }> {
    const due = work.due
      ? {
          dueDate: { year: work.due.getUTCFullYear(), month: work.due.getUTCMonth() + 1, day: work.due.getUTCDate() },
          dueTime: { hours: work.due.getUTCHours(), minutes: work.due.getUTCMinutes() },
        }
      : {};
    const created = await this.call<{ id?: string; alternateLink?: string }>(
      "POST",
      `/v1/courses/${encodeURIComponent(courseId)}/courseWork`,
      {
        title: work.title,
        description: work.description,
        materials: [{ link: { url: work.link, title: work.title } }],
        maxPoints: work.maxPoints,
        workType: "ASSIGNMENT",
        state: "PUBLISHED",
        ...due,
      },
    );
    if (!created.id) throw new GoogleError("api_failed", "Google Classroom didn't return the new coursework.");
    return { id: created.id, alternateLink: created.alternateLink ?? null };
  }

  async submissions(courseId: string, courseWorkId: string, userId?: string): Promise<StudentSubmission[]> {
    const list = await this.pages<Record<string, unknown>>(
      `/v1/courses/${encodeURIComponent(courseId)}/courseWork/${encodeURIComponent(courseWorkId)}/studentSubmissions${
        userId ? `?userId=${encodeURIComponent(userId)}` : ""
      }`,
      "studentSubmissions",
    );
    return list.map((s) => ({
      id: String(s.id),
      userId: String(s.userId),
      state: String(s.state ?? ""),
      assignedGrade: typeof s.assignedGrade === "number" ? s.assignedGrade : null,
      draftGrade: typeof s.draftGrade === "number" ? s.draftGrade : null,
    }));
  }

  /** Sets the grade and returns the submission, so the student sees it in Classroom. */
  async grade(courseId: string, courseWorkId: string, submissionId: string, grade: number): Promise<void> {
    const base = `/v1/courses/${encodeURIComponent(courseId)}/courseWork/${encodeURIComponent(courseWorkId)}/studentSubmissions/${encodeURIComponent(submissionId)}`;
    await this.call("PATCH", `${base}?updateMask=assignedGrade,draftGrade`, {
      assignedGrade: grade,
      draftGrade: grade,
    });
    await this.call("POST", `${base}:return`, {});
  }
}
