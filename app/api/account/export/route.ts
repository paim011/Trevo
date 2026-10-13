import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { buildAccountExport } from "@/lib/account";
import { authOptions } from "@/lib/auth";

// Acesso e portabilidade (LGPD, art. 18, II e V): devolve os dados da conta
// logada como um arquivo JSON para download. Só os dados do próprio titular
// -- o userId vem sempre da sessão, nunca da requisição.
export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }

  const data = await buildAccountExport(session.user.id);

  if (!data) {
    return NextResponse.json({ error: "Conta não encontrada" }, { status: 404 });
  }

  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="meus-dados-trevo.json"',
      "Cache-Control": "no-store",
    },
  });
}
