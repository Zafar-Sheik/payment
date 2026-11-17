/** An error that is safe to show to the API client. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }

  toBody() {
    return { error: { code: this.code, message: this.message } };
  }
}

export const badRequest = (code: string, msg: string) => new ApiError(400, code, msg);
export const unauthorized = (msg = 'Authentication required') => new ApiError(401, 'unauthorized', msg);
export const forbidden = (code: string, msg: string) => new ApiError(403, code, msg);
export const notFound = (msg = 'Not found') => new ApiError(404, 'not_found', msg);
export const conflict = (code: string, msg: string) => new ApiError(409, code, msg);
export const unprocessable = (code: string, msg: string) => new ApiError(422, code, msg);
