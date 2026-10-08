import { handleVercelApi } from '../server.mjs';

export default async function handler(req, res) {
  await handleVercelApi(req, res);
}
