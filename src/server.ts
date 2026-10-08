import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { errorHandler } from "./middleware/error-handler";
import { uploadRoutes } from "./routes/upload.routes";

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN ?? "*" }));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
app.use(express.json());

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});
app.use("/uploads", uploadRoutes);
app.use(errorHandler);

app.listen(port, () => {
  console.log(`CSV import API listening on http://localhost:${port}`);
});
