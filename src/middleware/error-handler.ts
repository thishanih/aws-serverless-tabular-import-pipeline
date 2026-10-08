import { ErrorRequestHandler } from "express";

export const errorHandler: ErrorRequestHandler = (
  error,
  _request,
  response,
  _next,
) => {
  if (error.type === "entity.too.large") {
    response
      .status(413)
      .json({ error: "File exceeds the 10 MB upload limit." });
    return;
  }
  response.status(400).json({ error: "Invalid request body." });
};
