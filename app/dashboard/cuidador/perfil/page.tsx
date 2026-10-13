import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";

import { AccountDataSection } from "@/app/dashboard/_components/account-data-section";
import { BackLink } from "@/app/dashboard/_components/back-link";
import { authOptions } from "@/lib/auth";
import { tryDecryptField } from "@/lib/field-encryption";
import { prisma } from "@/lib/prisma";

import { ProfileForm } from "./profile-form";

export default async function EditarPerfilCuidadorPage() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    redirect("/login");
  }

  const profile = await prisma.caregiverProfile.findUnique({
    where: { userId: session.user.id },
  });

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md">
        <BackLink href="/dashboard/cuidador" />
        <ProfileForm
          initialProfile={{
            phone:
              tryDecryptField(profile?.phone, "caregiverProfile.phone", session.user.id) ??
              "",
            city: profile?.city ?? "",
            state: profile?.state ?? "",
            bio: profile?.bio ?? "",
            hourlyRate: profile?.hourlyRate ? profile.hourlyRate.toString() : "",
            experienceYears: profile?.experienceYears?.toString() ?? "",
            careTypes: profile?.careTypes ?? [],
            visibleToFamilies: profile?.visibleToFamilies ?? true,
          }}
        />
        <AccountDataSection />
      </div>
    </main>
  );
}
