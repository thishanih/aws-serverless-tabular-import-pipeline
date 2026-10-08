import { Router } from "express";
import { createPresignedUpload } from "../controllers/upload.controller";

export const uploadRoutes = Router();

uploadRoutes.post("/presign", createPresignedUpload);
