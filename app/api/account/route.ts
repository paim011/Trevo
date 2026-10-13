import bcrypt from "bcryptjs";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { deleteAccount } from "@/lib/account";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CAREGIVER_DOCUMENTS_BUCKET, supabaseAdmin } from "@/lib/supabase-admin";

const deleteSchema = z.object({
  password: z.string().min(1, "Informe sua senha"),
});

// Eliminação dos dados (LGPD, art. 18, VI). Pede a senha de novo: uma
// sessão esquecida aberta em outro computador não deve bastar para apagar
// a conta. O que é apagado e o que é anonimizado está em lib/account.ts.
export async function DELETE(request: Request) {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }

  const parsed = deleteSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Dados inválidos", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { password: true, role: true },
  });

  if (!user?.password || !(await bcrypt.compare(parsed.data.password, user.password))) {
    return NextResponse.json({ error: "Senha incorreta" }, { status: 403 });
  }

  const documentPaths = await deleteAccount(session.user.id, user.role);

  if (documentPaths.length > 0) {
    const { error } = await supabaseAdmin.storage
      .from(CAREGIVER_DOCUMENTS_BUCKET)
      .remove(documentPaths);

    // A conta já foi excluída no banco; um arquivo que ficou para trás no
    // Storage é registrado (sem o caminho, que contém o nome do arquivo)
    // para remoção manual, mas não desfaz a exclusão.
    if (error) {
      console.error("[account] falha ao remover documentos do Storage", {
        userId: session.user.id,
        count: documentPaths.length,
      });
    }
  }

  return NextResponse.json({ deleted: true });
}
