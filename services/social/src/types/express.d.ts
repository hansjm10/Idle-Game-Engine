declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        preferredUsername: string;
      };
    }
  }
}

export {};
