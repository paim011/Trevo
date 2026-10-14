/**
 * Testes de controle de acesso (npm run test:security).
 *
 * Verifica, contra o site publicado e com as contas de demonstração, as regras
 * que decidem quem vê o quê: contato liberado só depois do aceite, contratação
 * alheia invisível, rotas que exigem login, perfil restrito ao próprio papel e
 * busca de famílias sem localização exata. Só faz consultas (GET) e o login das
 * contas de demonstração -- nenhum dado é gravado. A recusa do papel ADMIN no
 * cadastro é verificada direto no schema de validação do servidor, sem enviar
 * requisição, para não arriscar criar uma conta em produção.
 *
 * Alvo: SECURITY_TEST_URL (padrão: https://trevo-trevo6.vercel.app). Exige que
 * o banco tenha os dados de `npm run seed:demo`.
 */
import { registerSchema } from "../lib/register-schema";

const BASE = (process.env.SECURITY_TEST_URL ?? "https://trevo-trevo6.vercel.app").replace(/\/$/, "");
const DEMO_PASSWORD = "Demo@2026";
const PHONE_PATTERN = /\(\d{2}\)\s*\d{5}-\d{4}/;
const DISTANCE_BANDS = /^(até 5 km|5 a 10 km|10 a 20 km|20 a 50 km|mais de 50 km)$/;

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];

function check(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : ` -- ${detail}`}`);
}

// Sessão HTTP mínima: guarda os cookies entre as requisições, sem seguir
// redirecionamentos (para que um 307 de "faça login" apareça como tal).
class Session {
  private cookies = new Map<string, string>();

  async get(path: string) {
    return this.request(path, { method: "GET" });
  }

  async request(path: string, init: RequestInit) {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set("cookie", Array.from(this.cookies, ([k, v]) => `${k}=${v}`).join("; "));
    }
    const response = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(";");
      const index = pair.indexOf("=");
      this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  }

  async login(email: string) {
    const { csrfToken } = (await (await this.get("/api/auth/csrf")).json()) as { csrfToken: string };
    await this.request("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken, email, password: DEMO_PASSWORD, json: "true" }),
    });
    const session = (await (await this.get("/api/auth/session")).json()) as { user?: { role?: string } };
    if (!session.user?.role) throw new Error(`Login falhou para ${email}`);
    return this;
  }
}

async function hireLinks(session: Session, listPath: string): Promise<string[]> {
  const html = await (await session.get(listPath)).text();
  return Array.from(new Set(html.match(/\/dashboard\/hires\/[a-z0-9]+/g) ?? []));
}

// Texto visível aproximado de uma página (sem tags nem scripts).
async function pageText(session: Session, path: string) {
  const response = await session.get(path);
  const html = await response.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  return { status: response.status, html, text };
}

async function findHire(session: Session, listPath: string, statusLabel: string) {
  for (const link of await hireLinks(session, listPath)) {
    const page = await pageText(session, link);
    if (page.text.includes(statusLabel)) return { link, ...page };
  }
  throw new Error(`Nenhuma contratação "${statusLabel}" em ${listPath}`);
}

function hasKeyDeep(value: unknown, pattern: RegExp): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = hasKeyDeep(item, pattern);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (pattern.test(key)) return key;
      const found = hasKeyDeep(inner, pattern);
      if (found) return found;
    }
  }
  return null;
}

async function main() {
  console.log(`\nAlvo: ${BASE}\n`);

  console.log("Cadastro");
  const validFamily = {
    email: "teste@exemplo.com",
    password: "senha-de-teste",
    name: "Teste",
    birthDate: "1990-01-01",
    phone: "62999990000",
    city: "Goiânia",
    state: "GO",
    acceptPrivacyPolicy: true,
    address: "Rua de teste, 1",
  };
  const asFamily = registerSchema.safeParse({ ...validFamily, role: "FAMILY" });
  const asAdmin = registerSchema.safeParse({ ...validFamily, role: "ADMIN" });
  check(
    "o cadastro recusa o papel ADMIN (o mesmo dado com papel FAMILY é aceito)",
    asFamily.success && !asAdmin.success,
    `FAMILY aceito: ${asFamily.success}; ADMIN aceito: ${asAdmin.success}`
  );

  console.log("Rotas que exigem login (visitante)");
  const visitor = new Session();
  const reviews = await visitor.get("/api/reviews?caregiverId=qualquer");
  check("a rota de avaliações recusa visitantes (401)", reviews.status === 401, `status ${reviews.status}`);
  const exportResponse = await visitor.get("/api/account/export");
  check("a exportação de dados recusa visitantes (401)", exportResponse.status === 401, `status ${exportResponse.status}`);

  console.log("Contato da outra parte");
  const family1 = await new Session().login("familia1@demo.trevo.app");
  const accepted = await findHire(family1, "/dashboard/familia/contratacoes", "Aceita");
  check(
    "contratação aceita: o telefone da outra parte é exibido",
    accepted.status === 200 && accepted.text.includes("Contato") && PHONE_PATTERN.test(accepted.text),
    `status ${accepted.status}`
  );

  const family3 = await new Session().login("familia3@demo.trevo.app");
  const pending = await findHire(family3, "/dashboard/familia/contratacoes", "Pendente");
  check(
    "contratação pendente: o telefone não é exibido nem enviado na página",
    pending.status === 200 && !pending.text.includes("Contato") && !PHONE_PATTERN.test(pending.html),
    `status ${pending.status}`
  );

  const family2 = await new Session().login("familia2@demo.trevo.app");
  const foreign = await family2.get(accepted.link);
  check(
    "contratação de outras pessoas responde como inexistente (404)",
    foreign.status === 404,
    `status ${foreign.status}`
  );

  console.log("Perfil e busca do cuidador");
  const caregiver = await new Session().login("cuidador1@demo.trevo.app");
  const familyProfile = await caregiver.get("/api/family-profile");
  check(
    "um cuidador não acessa a API de perfil de família (403)",
    familyProfile.status === 403,
    `status ${familyProfile.status}`
  );

  const search = await caregiver.get("/api/search/families");
  const body = (await search.json()) as { results?: Array<{ distance?: string }> };
  const list = body.results ?? [];
  const leakedKey = hasKeyDeep(body, /^(latitude|longitude|lat|lng|address)$/i);
  check(
    "a busca de famílias não devolve coordenadas nem endereço",
    search.status === 200 && list.length > 0 && leakedKey === null,
    `status ${search.status}; ${list.length} resultados; campo exposto: ${leakedKey}`
  );
  check(
    "a busca de famílias devolve a distância apenas em faixas",
    list.length > 0 && list.every((item) => DISTANCE_BANDS.test(item.distance ?? "")),
    `distâncias: ${list.map((item) => item.distance).join(", ")}`
  );

  const searchPage = await pageText(caregiver, "/dashboard/cuidador/buscar");
  check(
    "a página de busca do cuidador não inclui coordenadas no HTML",
    searchPage.status === 200 && !/latitude|longitude/i.test(searchPage.html),
    `status ${searchPage.status}`
  );

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length} de ${results.length} verificações aprovadas.`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
