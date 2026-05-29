import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
/** Raiz do repositório (pasta que contém `.env`). */
export const repoRootDir = path.resolve(serverDir, '..');

dotenv.config({ path: path.join(repoRootDir, '.env') });
