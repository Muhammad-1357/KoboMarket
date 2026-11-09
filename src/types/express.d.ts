import type { JwtPayload } from "jsonwebtoken";

declare module "http" {
  interface IncomingMessage {
    rawBody?: Buffer;
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; roles: string[] };
      id?: string;
      rawBody?: Buffer;
    }
  }
}

export type AccessTokenPayload = JwtPayload & { sub: string; roles: string[] };
