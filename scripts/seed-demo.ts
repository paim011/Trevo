import {
  CareType,
  CaregiverAvailability,
  HireInitiator,
  HireStatus,
  Role,
} from "@prisma/client";
import bcrypt from "bcryptjs";

import { encryptField } from "@/lib/field-encryption";
import { buildGeocodeQuery, geocodeAddress, GeocodeResult } from "@/lib/geocoding";
import { prisma } from "@/lib/prisma";

// Caixa delimitadora aproximada do estado de Goiás. Todas as pessoas demo
// vivem na região metropolitana de Goiânia, então qualquer resultado de
// geocodificação que caia fora dessa caixa é necessariamente um erro de
// desambiguação do Nominatim (ex.: casando com um bairro de mesmo nome em
// outro estado), não um resultado real -- essa é uma checagem de sanidade
// específica deste dataset de demonstração, não uma preocupação de
// propósito geral de lib/geocoding.ts.
const GOIAS_BOUNDS = {
  minLatitude: -19.5,
  maxLatitude: -12.5,
  minLongitude: -53.5,
  maxLongitude: -45.9,
};

function isWithinGoiasBounds(result: GeocodeResult): boolean {
  return (
    result.latitude >= GOIAS_BOUNDS.minLatitude &&
    result.latitude <= GOIAS_BOUNDS.maxLatitude &&
    result.longitude >= GOIAS_BOUNDS.minLongitude &&
    result.longitude <= GOIAS_BOUNDS.maxLongitude
  );
}

// Tenta cada query em ordem (mais específica primeiro) e retorna o primeiro
// resultado que tanto geocodifica com sucesso QUANTO passa na checagem da
// caixa delimitadora de Goiás. Cidades menores como Trindade/Aparecida de
// Goiânia não são mapeadas tão densamente no OSM quanto a própria Goiânia,
// então uma rua + número fictícios excessivamente específicos às vezes não
// retornam nenhum resultado -- cair para uma query mais ampla (mas ainda
// qualificada como Goiás) troca um pouco de precisão em vez de deixar o
// perfil sem nenhuma coordenada.
async function geocodeWithSanityCheck(
  queries: string[],
  label: string
): Promise<GeocodeResult | null> {
  for (let attempt = 0; attempt < queries.length; attempt++) {
    const query = queries[attempt];
    const result = await geocodeAddress(query);

    if (!result) {
      console.log(
        `  Geocodificando ${label} (tentativa ${attempt + 1}/${queries.length}, "${query}")... sem resultado`
      );
      continue;
    }

    if (!isWithinGoiasBounds(result)) {
      console.log(
        `  Geocodificando ${label} (tentativa ${attempt + 1}/${queries.length}, "${query}")... ` +
          `FALHA DE SANIDADE: coordenada (${result.latitude.toFixed(5)}, ${result.longitude.toFixed(5)}) ` +
          `cai fora de Goiás -- descartando.`
      );
      continue;
    }

    console.log(
      `  Geocodificando ${label}... OK (${result.latitude.toFixed(5)}, ${result.longitude.toFixed(5)})` +
        (attempt > 0 ? " [endereço específico falhou, usando fallback menos preciso]" : "")
    );
    return result;
  }

  console.log(
    `  Geocodificando ${label}... falhou em todas as ${queries.length} tentativas -- ` +
      `latitude/longitude ficarão null. Corrija o endereço manualmente se necessário.`
  );
  return null;
}

// Todas as contas demo compartilham esse domínio para que cleanup() consiga
// encontrar (e remover) elas por um único filtro inequívoco -- nunca
// apagando dados reais de usuário por acidente.
const EMAIL_DOMAIN = "@demo.trevo.app";
const DEMO_PASSWORD = "Demo@2026";
const BCRYPT_SALT_ROUNDS = 12;

type CaregiverSeed = {
  email: string;
  name: string;
  phone: string;
  // street/neighborhood existem só para montar uma query de geocodificação
  // específica -- CaregiverProfile não tem coluna de endereço, então esses
  // valores nunca são persistidos, só city/state são.
  street: string;
  neighborhood: string;
  city: string;
  state: string;
  bio: string;
  careTypes: CareType[];
  hourlyRate: number;
  experienceYears: number;
  availabilityStatus: CaregiverAvailability;
  // Opcional, assume true (visível) quando omitido -- só um cuidador seed
  // define isso como false, para demonstrar que o controle realmente o
  // esconde da busca/matching da família (ver CLAUDE.md "Dados de
  // demonstração").
  visibleToFamilies?: boolean;
};

type FamilySeed = {
  email: string;
  name: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  bio: string;
  neededCareTypes: CareType[];
  // Opcional, deixado undefined numa família de propósito -- exercita as
  // camadas de fallback neutro/relativo de computePriceScore (sem orçamento
  // declarado). Ver CLAUDE.md "Dados de demonstração".
  hourlyBudget?: number;
  // Opcional, assume true (visível) quando omitido -- só uma família seed
  // define isso como false, para demonstrar que o controle realmente a
  // esconde da busca/matching do cuidador.
  visibleToCaregivers?: boolean;
};

// Ruas/bairros reais em Goiânia e sua região metropolitana, cada um pareado
// com um número de casa fictício (mas plausível). Específico o bastante
// para que o Nominatim não precise adivinhar entre duas pessoas diferentes
// que moram na mesma cidade, e para que não confunda "Centro" ou "Setor X"
// com um bairro de mesmo nome em outro estado -- as queries montadas em
// seedCaregivers/seedFamilies abaixo também acrescentam "Goiás, Brasil"
// explicitamente pelo mesmo motivo. 15 cuidadores / 15 famílias espalhados
// por seis cidades da região metropolitana (Goiânia, Aparecida de Goiânia,
// Trindade, Senador Canedo, mais Goianira e Bela Vista de Goiás
// adicionadas quando o dataset cresceu de 5/3 para 15/15) para que a
// distância realmente varie de forma significativa nos resultados de busca
// em vez de todo mundo ficar a poucos km de distância.
const CAREGIVER_SEEDS: CaregiverSeed[] = [
  {
    email: `cuidador1${EMAIL_DOMAIN}`,
    name: "Ana Paula Ferreira",
    phone: "(62) 99111-2233",
    street: "Rua T-63, 1200",
    neighborhood: "Setor Bueno",
    city: "Goiânia",
    state: "GO",
    bio: "Cuidadora de idosos há 8 anos, especializada em mobilidade reduzida e acompanhamento de medicação.",
    careTypes: [CareType.ELDERLY],
    hourlyRate: 25,
    experienceYears: 8,
    availabilityStatus: CaregiverAvailability.AVAILABLE,
  },
  {
    email: `cuidador2${EMAIL_DOMAIN}`,
    name: "Bruno Costa Lima",
    phone: "(62) 99222-3344",
    street: "Avenida Independência, 850",
    neighborhood: "Jardim Tiradentes",
    city: "Aparecida de Goiânia",
    state: "GO",
    bio: "Cuidador infantil, atendo crianças de 0 a 10 anos com apoio em rotina diária e tarefas escolares.",
    careTypes: [CareType.CHILD],
    hourlyRate: 20,
    experienceYears: 1,
    availabilityStatus: CaregiverAvailability.BUSY,
  },
  {
    email: `cuidador3${EMAIL_DOMAIN}`,
    name: "Camila Rodrigues Santos",
    phone: "(62) 99333-4455",
    street: "Avenida Universitária, 400",
    neighborhood: "Vila Brasil",
    city: "Trindade",
    state: "GO",
    bio: "Atendo idosos e crianças, com experiência em cuidados domiciliares e noções de primeiros socorros.",
    careTypes: [CareType.ELDERLY, CareType.CHILD],
    hourlyRate: 35,
    experienceYears: 6,
    availabilityStatus: CaregiverAvailability.AVAILABLE,
  },
  {
    email: `cuidador4${EMAIL_DOMAIN}`,
    name: "Diego Almeida Souza",
    phone: "(62) 99444-5566",
    street: "Avenida Brasil, 620",
    neighborhood: "Centro",
    city: "Senador Canedo",
    state: "GO",
    bio: "12 anos de experiência cuidando de idosos, crianças e pessoas com necessidades especiais.",
    careTypes: [CareType.ELDERLY, CareType.CHILD, CareType.SPECIAL_NEEDS],
    hourlyRate: 45,
    experienceYears: 12,
    availabilityStatus: CaregiverAvailability.BUSY,
  },
  {
    email: `cuidador5${EMAIL_DOMAIN}`,
    name: "Elisa Martins Oliveira",
    phone: "(62) 99555-6677",
    street: "Rua 84, 300",
    neighborhood: "Setor Marista",
    city: "Goiânia",
    state: "GO",
    bio: "Especialista em cuidados infantis e necessidades especiais, com formação em pedagogia terapêutica.",
    careTypes: [CareType.CHILD, CareType.SPECIAL_NEEDS],
    hourlyRate: 60,
    experienceYears: 15,
    availabilityStatus: CaregiverAvailability.UNAVAILABLE,
    // Demonstra o visibleToFamilies realmente escondendo um cuidador da
    // busca/matching da família -- ver CLAUDE.md "Dados de demonstração".
    visibleToFamilies: false,
  },
  {
    email: `cuidador6${EMAIL_DOMAIN}`,
    name: "Rafael Souza Martins",
    phone: "(62) 99666-7788",
    street: "Rua Central, 45",
    neighborhood: "Centro",
    city: "Goianira",
    state: "GO",
    bio: "Iniciando na área de cuidados, atendo idosos com muita dedicação e paciência.",
    careTypes: [CareType.ELDERLY],
    hourlyRate: 18,
    experienceYears: 0,
    availabilityStatus: CaregiverAvailability.AVAILABLE,
  },
  {
    email: `cuidador7${EMAIL_DOMAIN}`,
    name: "Juliana Alves Barbosa",
    phone: "(62) 99777-8899",
    street: "Rua 90, 220",
    neighborhood: "Setor Oeste",
    city: "Goiânia",
    state: "GO",
    bio: "Cuidadora especializada em crianças e pessoas com necessidades especiais, com formação em terapia ocupacional.",
    careTypes: [CareType.CHILD, CareType.SPECIAL_NEEDS],
    hourlyRate: 42,
    experienceYears: 5,
    availabilityStatus: CaregiverAvailability.BUSY,
  },
  {
    email: `cuidador8${EMAIL_DOMAIN}`,
    name: "Marcos Vinícius Pereira",
    phone: "(62) 99888-9900",
    street: "Rua das Acácias, 310",
    neighborhood: "Cidade Livre",
    city: "Aparecida de Goiânia",
    state: "GO",
    bio: "20 anos de experiência atendendo idosos, crianças e pessoas com necessidades especiais em tempo integral.",
    careTypes: [CareType.ELDERLY, CareType.CHILD, CareType.SPECIAL_NEEDS],
    hourlyRate: 70,
    experienceYears: 20,
    availabilityStatus: CaregiverAvailability.AVAILABLE,
  },
  {
    email: `cuidador9${EMAIL_DOMAIN}`,
    name: "Fernanda Cristina Lopes",
    phone: "(62) 99000-1122",
    street: "Rua das Palmeiras, 88",
    neighborhood: "Residencial Trindade",
    city: "Trindade",
    state: "GO",
    bio: "Especialista em necessidades especiais, com formação em fisioterapia e acompanhamento terapêutico.",
    careTypes: [CareType.SPECIAL_NEEDS],
    hourlyRate: 30,
    experienceYears: 3,
    availabilityStatus: CaregiverAvailability.UNAVAILABLE,
  },
  {
    email: `cuidador10${EMAIL_DOMAIN}`,
    name: "Thiago Henrique Rocha",
    phone: "(62) 99123-4567",
    street: "Rua Goiás, 502",
    neighborhood: "Vila São José",
    city: "Senador Canedo",
    state: "GO",
    bio: "Atendo idosos e crianças com flexibilidade de horário e experiência em rotina domiciliar.",
    careTypes: [CareType.ELDERLY, CareType.CHILD],
    hourlyRate: 28,
    experienceYears: 4,
    availabilityStatus: CaregiverAvailability.AVAILABLE,
  },
  {
    email: `cuidador11${EMAIL_DOMAIN}`,
    name: "Patrícia Gomes Nascimento",
    phone: "(62) 99234-5678",
    street: "Rua Principal, 12",
    neighborhood: "Centro",
    city: "Bela Vista de Goiás",
    state: "GO",
    bio: "Cuidadora infantil recém-formada, atenciosa e disponível para período integral.",
    careTypes: [CareType.CHILD],
    hourlyRate: 19,
    experienceYears: 0,
    availabilityStatus: CaregiverAvailability.BUSY,
  },
  {
    email: `cuidador12${EMAIL_DOMAIN}`,
    name: "Rodrigo Teixeira Vieira",
    phone: "(62) 99345-6789",
    street: "Rua 15, 730",
    neighborhood: "Setor Sul",
    city: "Goiânia",
    state: "GO",
    bio: "17 anos de experiência com idosos, especializado em cuidados paliativos e mobilidade reduzida.",
    careTypes: [CareType.ELDERLY],
    hourlyRate: 55,
    experienceYears: 17,
    availabilityStatus: CaregiverAvailability.UNAVAILABLE,
  },
  {
    email: `cuidador13${EMAIL_DOMAIN}`,
    name: "Larissa Cunha Ramos",
    phone: "(62) 99456-7890",
    street: "Avenida das Flores, 145",
    neighborhood: "Buriti Sereno",
    city: "Aparecida de Goiânia",
    state: "GO",
    bio: "Atendo idosos e pessoas com necessidades especiais, com curso técnico em enfermagem.",
    careTypes: [CareType.ELDERLY, CareType.SPECIAL_NEEDS],
    hourlyRate: 38,
    experienceYears: 9,
    availabilityStatus: CaregiverAvailability.AVAILABLE,
  },
  {
    email: `cuidador14${EMAIL_DOMAIN}`,
    name: "Eduardo Nunes Farias",
    phone: "(62) 99567-8901",
    street: "Rua dos Ipês, 60",
    neighborhood: "Residencial Buena Vista",
    city: "Goianira",
    state: "GO",
    bio: "14 anos cuidando de idosos, crianças e pessoas com necessidades especiais, com muita experiência prática.",
    careTypes: [CareType.CHILD, CareType.ELDERLY, CareType.SPECIAL_NEEDS],
    hourlyRate: 65,
    experienceYears: 14,
    availabilityStatus: CaregiverAvailability.BUSY,
    // Segundo cuidador (além de cuidador5/Elisa) demonstrando
    // visibleToFamilies -- ver CLAUDE.md "Dados de demonstração".
    visibleToFamilies: false,
  },
  {
    email: `cuidador15${EMAIL_DOMAIN}`,
    name: "Camilla Duarte Moreira",
    phone: "(62) 99678-9012",
    street: "Rua do Comércio, 25",
    neighborhood: "Village Terrasse",
    city: "Trindade",
    state: "GO",
    bio: "Cuidadora infantil com experiência em rotina escolar e atividades recreativas.",
    careTypes: [CareType.CHILD],
    hourlyRate: 22,
    experienceYears: 2,
    availabilityStatus: CaregiverAvailability.UNAVAILABLE,
    // Terceiro cuidador demonstrando visibleToFamilies (ver CLAUDE.md
    // "Dados de demonstração") -- combinado com UNAVAILABLE acima, mesma
    // narrativa "indisponível e fora de busca" já usada para cuidador5.
    visibleToFamilies: false,
  },
];

const FAMILY_SEEDS: FamilySeed[] = [
  {
    email: `familia1${EMAIL_DOMAIN}`,
    name: "Família Pereira",
    phone: "(62) 98111-1122",
    address: "Rua T-30, 555 - Setor Bueno",
    city: "Goiânia",
    state: "GO",
    bio: "Buscamos cuidador(a) para nossa mãe idosa, com mobilidade reduzida.",
    neededCareTypes: [CareType.ELDERLY],
    // Abaixo do que os cuidadores capazes de ELDERLY cobram (cuidador1
    // R$25, cuidador3 R$35, cuidador4 R$45) -- exercita a camada de
    // orçamento de computePriceScore com o cuidador acima do orçamento.
    hourlyBudget: 20,
  },
  {
    email: `familia2${EMAIL_DOMAIN}`,
    name: "Família Souza",
    phone: "(62) 98222-2233",
    address: "Rua Uirapuru, 210 - Jardim América",
    city: "Aparecida de Goiânia",
    state: "GO",
    bio: "Precisamos de apoio no cuidado dos nossos filhos gêmeos, período vespertino.",
    neededCareTypes: [CareType.CHILD],
    // Acima do que todo cuidador capaz de CHILD cobra (cuidador2 R$20,
    // cuidador3 R$35, cuidador4 R$45, cuidador5 R$60) -- exercita a camada
    // de orçamento de computePriceScore com todo candidato dentro do
    // orçamento.
    hourlyBudget: 70,
    // Demonstra o visibleToCaregivers realmente escondendo uma família da
    // busca/matching do cuidador -- ver CLAUDE.md "Dados de demonstração".
    visibleToCaregivers: false,
  },
  {
    email: `familia3${EMAIL_DOMAIN}`,
    name: "Família Ribeiro",
    phone: "(62) 98333-3344",
    address: "Avenida Rotariana, 150 - Centro",
    city: "Trindade",
    state: "GO",
    bio: "Família busca cuidador(a) para atender avó idosa e sobrinho com necessidades especiais.",
    neededCareTypes: [CareType.ELDERLY, CareType.CHILD, CareType.SPECIAL_NEEDS],
  },
  {
    email: `familia4${EMAIL_DOMAIN}`,
    name: "Família Almeida",
    phone: "(62) 98444-5511",
    address: "Rua 8, 300 - Setor Central",
    city: "Goiânia",
    state: "GO",
    bio: "Cuidamos do nosso pai idoso, que precisa de acompanhamento diário.",
    neededCareTypes: [CareType.ELDERLY],
  },
  {
    email: `familia5${EMAIL_DOMAIN}`,
    name: "Família Carvalho",
    phone: "(62) 98555-6622",
    address: "Rua Bela Vista, 120 - Jardim América",
    city: "Aparecida de Goiânia",
    state: "GO",
    bio: "Buscamos apoio para nosso filho com necessidades especiais e sua rotina escolar.",
    neededCareTypes: [CareType.CHILD, CareType.SPECIAL_NEEDS],
    hourlyBudget: 55,
  },
  {
    email: `familia6${EMAIL_DOMAIN}`,
    name: "Família Nogueira",
    phone: "(62) 98666-7733",
    address: "Rua Central, 78 - Centro",
    city: "Trindade",
    state: "GO",
    bio: "Precisamos de cuidador(a) para revezar entre nossa avó e nossos filhos pequenos.",
    neededCareTypes: [CareType.ELDERLY, CareType.CHILD],
  },
  {
    email: `familia7${EMAIL_DOMAIN}`,
    name: "Família Barros",
    phone: "(62) 98777-8844",
    address: "Rua Goiás, 210 - Jardim Primavera",
    city: "Senador Canedo",
    state: "GO",
    bio: "Nosso filho tem necessidades especiais e precisa de acompanhamento especializado.",
    neededCareTypes: [CareType.SPECIAL_NEEDS],
    hourlyBudget: 25,
  },
  {
    email: `familia8${EMAIL_DOMAIN}`,
    name: "Família Correia",
    phone: "(62) 98888-9955",
    address: "Rua das Mangueiras, 33 - Centro",
    city: "Goianira",
    state: "GO",
    bio: "Família grande, buscamos cuidador(a) versátil para idosos, crianças e necessidades especiais.",
    neededCareTypes: [CareType.ELDERLY, CareType.CHILD, CareType.SPECIAL_NEEDS],
    // Segunda família (além de família2/Souza) demonstrando
    // visibleToCaregivers -- ver CLAUDE.md "Dados de demonstração".
    visibleToCaregivers: false,
  },
  {
    email: `familia9${EMAIL_DOMAIN}`,
    name: "Família Dias",
    phone: "(62) 98999-0011",
    address: "Rua Principal, 90 - Setor Aeroporto",
    city: "Bela Vista de Goiás",
    state: "GO",
    bio: "Precisamos de cuidado para nossa filha pequena no contraturno escolar.",
    neededCareTypes: [CareType.CHILD],
    hourlyBudget: 15,
  },
  {
    email: `familia10${EMAIL_DOMAIN}`,
    name: "Família Farias",
    phone: "(62) 98101-2233",
    address: "Rua 22, 415 - Setor Sul",
    city: "Goiânia",
    state: "GO",
    bio: "Buscamos cuidador(a) para nosso avô, que mora conosco.",
    neededCareTypes: [CareType.ELDERLY],
  },
  {
    email: `familia11${EMAIL_DOMAIN}`,
    name: "Família Machado",
    phone: "(62) 98202-3344",
    address: "Avenida Buriti, 500 - Cidade Livre",
    city: "Aparecida de Goiânia",
    state: "GO",
    bio: "Cuidamos de nossa mãe idosa e de nosso irmão com necessidades especiais.",
    neededCareTypes: [CareType.ELDERLY, CareType.SPECIAL_NEEDS],
    hourlyBudget: 60,
  },
  {
    email: `familia12${EMAIL_DOMAIN}`,
    name: "Família Peixoto",
    phone: "(62) 98303-4455",
    address: "Rua Nova, 60 - Residencial Trindade",
    city: "Trindade",
    state: "GO",
    bio: "Precisamos de apoio no cuidado do nosso filho recém-nascido.",
    neededCareTypes: [CareType.CHILD],
    // Terceira família demonstrando visibleToCaregivers -- ver CLAUDE.md
    // "Dados de demonstração".
    visibleToCaregivers: false,
  },
  {
    email: `familia13${EMAIL_DOMAIN}`,
    name: "Família Queiroz",
    phone: "(62) 98404-5566",
    address: "Avenida Brasil, 700 - Vila São José",
    city: "Senador Canedo",
    state: "GO",
    bio: "Buscamos cuidador(a) para revezar entre nossos pais idosos e nossos filhos.",
    neededCareTypes: [CareType.ELDERLY, CareType.CHILD],
    hourlyBudget: 40,
  },
  {
    email: `familia14${EMAIL_DOMAIN}`,
    name: "Família Rezende",
    phone: "(62) 98505-6677",
    address: "Rua dos Girassóis, 15 - Residencial Buena Vista",
    city: "Goianira",
    state: "GO",
    bio: "Nossa filha tem necessidades especiais e precisa de acompanhamento terapêutico.",
    neededCareTypes: [CareType.SPECIAL_NEEDS],
  },
  {
    email: `familia15${EMAIL_DOMAIN}`,
    name: "Família Sales",
    phone: "(62) 98606-7788",
    address: "Rua do Centro, 5 - Centro",
    city: "Bela Vista de Goiás",
    state: "GO",
    bio: "Família ampla, buscamos cuidador(a) de confiança para idosos, crianças e necessidades especiais.",
    neededCareTypes: [CareType.ELDERLY, CareType.CHILD, CareType.SPECIAL_NEEDS],
    hourlyBudget: 80,
  },
];

// Índices em FAMILY_SEEDS / CAREGIVER_SEEDS. Deliberadamente concentrado em
// só 3 famílias (Pereira, Souza, Ribeiro) x 3 cuidadores (Ana Paula, Bruno,
// Diego) -- as contas de vitrine originais de quando o dataset era 3
// famílias/5 cuidadores -- em vez de espalhar o histórico de Hire de forma
// rala por todos os 15/15: um único login durante a apresentação tem algo
// para mostrar (Pereira e Ribeiro acabam com 3 Hires cada, Diego com 3,
// Souza/Ana Paula/Bruno com 2 cada), enquanto as outras 12 famílias e 12
// cuidadores adicionados depois não têm nenhum histórico de Hire, o que é
// normal -- eles existem para povoar resultados de busca/matching, não as
// telas de contratações/solicitações.
const HIRE_SEEDS: Array<{
  familyIndex: number;
  caregiverIndex: number;
  status: HireStatus;
  // Precisa estar dentro da interseção real entre FAMILY_SEEDS[familyIndex]
  // .neededCareTypes e CAREGIVER_SEEDS[caregiverIndex].careTypes -- mesma
  // regra que POST /api/hires aplica no servidor (ver CLAUDE.md "Tipo de
  // cuidado do Hire").
  careType: CareType;
  // Quem entrou em contato primeiro -- ver CLAUDE.md "Fluxo de contratação
  // (Hire)". Majoritariamente FAMILY (bate com o padrão pré-Fase-2 que todo
  // Hire seed existente já tinha), com alguns CAREGIVER entre os registros
  // novos para exercitar também a direção "cuidador demonstrou interesse".
  initiatedBy: HireInitiator;
  message?: string;
  review?: { rating: number; comment: string };
}> = [
  {
    familyIndex: 0,
    caregiverIndex: 0,
    status: HireStatus.COMPLETED,
    careType: CareType.ELDERLY,
    initiatedBy: HireInitiator.FAMILY,
    review: {
      rating: 5,
      comment: "Ana foi maravilhosa com minha mãe, muito atenciosa e pontual!",
    },
  },
  {
    familyIndex: 1,
    caregiverIndex: 1,
    status: HireStatus.COMPLETED,
    careType: CareType.CHILD,
    initiatedBy: HireInitiator.FAMILY,
    review: {
      rating: 3,
      comment: "Bom cuidado com as crianças, mas às vezes chegou atrasado.",
    },
  },
  {
    familyIndex: 2,
    caregiverIndex: 3,
    status: HireStatus.PENDING,
    careType: CareType.SPECIAL_NEEDS,
    initiatedBy: HireInitiator.FAMILY,
    message: "Olá Diego, gostaríamos de contratar seus serviços para cuidar da minha avó e do meu sobrinho.",
  },
  {
    familyIndex: 0,
    caregiverIndex: 3,
    status: HireStatus.ACCEPTED,
    careType: CareType.ELDERLY,
    initiatedBy: HireInitiator.FAMILY,
    message: "Precisaríamos de apoio adicional nos fins de semana, além do cuidado já combinado.",
  },
  // Um segundo Hire, anterior, entre o mesmo par do primeiro registro acima
  // (Pereira x Ana Paula) -- válido porque ambos são status terminais
  // (COMPLETED e REJECTED deixam activeHireKey null, então a constraint
  // única nunca vê um conflito): uma primeira tentativa que não deu certo,
  // seguida depois pela bem-sucedida já semeada acima.
  {
    familyIndex: 0,
    caregiverIndex: 0,
    status: HireStatus.REJECTED,
    careType: CareType.ELDERLY,
    initiatedBy: HireInitiator.CAREGIVER,
    message: "Olá, tenho disponibilidade para cuidar da sua mãe, posso ajudar?",
  },
  {
    familyIndex: 1,
    caregiverIndex: 3,
    status: HireStatus.CANCELLED,
    careType: CareType.CHILD,
    initiatedBy: HireInitiator.CAREGIVER,
    message: "Posso ajudar com o cuidado das crianças no período que vocês precisarem.",
  },
  {
    familyIndex: 2,
    caregiverIndex: 0,
    status: HireStatus.PENDING,
    careType: CareType.ELDERLY,
    initiatedBy: HireInitiator.CAREGIVER,
    message: "Tenho experiência com idosos e gostaria de atender sua avó.",
  },
  {
    familyIndex: 2,
    caregiverIndex: 1,
    status: HireStatus.ACCEPTED,
    careType: CareType.CHILD,
    initiatedBy: HireInitiator.FAMILY,
    message: "Precisamos de ajuda com as crianças enquanto cuidamos da avó.",
  },
];

export async function cleanup() {
  await prisma.hire.deleteMany({
    where: {
      OR: [
        { family: { email: { endsWith: EMAIL_DOMAIN } } },
        { caregiver: { email: { endsWith: EMAIL_DOMAIN } } },
      ],
    },
  });

  // Propaga em cascata para FamilyProfile/CaregiverProfile (e, através
  // deles, Document), Account e Session -- ver prisma/schema.prisma.
  const deleted = await prisma.user.deleteMany({
    where: { email: { endsWith: EMAIL_DOMAIN } },
  });

  return deleted.count;
}

async function seedCaregivers(hashedPassword: string) {
  const userIdByEmail = new Map<string, string>();

  for (const seed of CAREGIVER_SEEDS) {
    const queries = [
      buildGeocodeQuery([seed.street, seed.neighborhood, seed.city, "Goiás, Brasil"]),
      buildGeocodeQuery([seed.neighborhood, seed.city, "Goiás, Brasil"]),
      buildGeocodeQuery([seed.city, "Goiás, Brasil"]),
    ].filter((query): query is string => Boolean(query));

    const geocoded = await geocodeWithSanityCheck(queries, `cuidador "${seed.name}"`);

    const user = await prisma.user.create({
      data: {
        email: seed.email,
        name: seed.name,
        password: hashedPassword,
        role: Role.CAREGIVER,
        privacyAcceptedAt: new Date(),
        caregiverProfile: {
          create: {
            city: seed.city,
            state: seed.state,
            bio: seed.bio,
            careTypes: seed.careTypes,
            hourlyRate: seed.hourlyRate,
            experienceYears: seed.experienceYears,
            availabilityStatus: seed.availabilityStatus,
            visibleToFamilies: seed.visibleToFamilies ?? true,
            latitude: geocoded?.latitude,
            longitude: geocoded?.longitude,
          },
        },
      },
    });

    // O telefone é cifrado com o id do usuário na AAD (ver
    // lib/field-encryption.ts), e esse id só existe depois do create acima.
    await prisma.caregiverProfile.update({
      where: { userId: user.id },
      data: { phone: encryptField(seed.phone, "caregiverProfile.phone", user.id) },
    });

    userIdByEmail.set(seed.email, user.id);
  }

  return userIdByEmail;
}

async function seedFamilies(hashedPassword: string) {
  const userIdByEmail = new Map<string, string>();

  for (const seed of FAMILY_SEEDS) {
    const queries = [
      buildGeocodeQuery([seed.address, seed.city, "Goiás, Brasil"]),
      buildGeocodeQuery([seed.city, "Goiás, Brasil"]),
    ].filter((query): query is string => Boolean(query));

    const geocoded = await geocodeWithSanityCheck(queries, seed.name);

    const user = await prisma.user.create({
      data: {
        email: seed.email,
        name: seed.name,
        password: hashedPassword,
        role: Role.FAMILY,
        privacyAcceptedAt: new Date(),
        familyProfile: {
          create: {
            city: seed.city,
            state: seed.state,
            bio: seed.bio,
            // Toda família demo tem descrição, então precisa do consentimento
            // para dados de saúde (ver app/api/family-profile/route.ts).
            healthDataConsentAt: new Date(),
            neededCareTypes: seed.neededCareTypes,
            hourlyBudget: seed.hourlyBudget,
            visibleToCaregivers: seed.visibleToCaregivers ?? true,
            latitude: geocoded?.latitude,
            longitude: geocoded?.longitude,
          },
        },
      },
    });

    // Mesma razão do seedCaregivers: a AAD precisa do id do usuário.
    await prisma.familyProfile.update({
      where: { userId: user.id },
      data: {
        phone: encryptField(seed.phone, "familyProfile.phone", user.id),
        address: encryptField(seed.address, "familyProfile.address", user.id),
      },
    });

    userIdByEmail.set(seed.email, user.id);
  }

  return userIdByEmail;
}

async function seedHires(
  familyIdByEmail: Map<string, string>,
  caregiverIdByEmail: Map<string, string>
) {
  const TERMINAL_STATUSES: HireStatus[] = [
    HireStatus.REJECTED,
    HireStatus.COMPLETED,
    HireStatus.CANCELLED,
  ];

  for (const hireSeed of HIRE_SEEDS) {
    const familyId = familyIdByEmail.get(
      FAMILY_SEEDS[hireSeed.familyIndex].email
    );
    const caregiverId = caregiverIdByEmail.get(
      CAREGIVER_SEEDS[hireSeed.caregiverIndex].email
    );

    if (!familyId || !caregiverId) {
      throw new Error("Family or caregiver missing while seeding hires");
    }

    const isActive = !TERMINAL_STATUSES.includes(hireSeed.status);

    const hire = await prisma.hire.create({
      data: {
        familyId,
        caregiverId,
        status: hireSeed.status,
        careType: hireSeed.careType,
        initiatedBy: hireSeed.initiatedBy,
        message: hireSeed.message,
        activeHireKey: isActive ? `${familyId}:${caregiverId}` : null,
      },
    });

    if (hireSeed.review) {
      await prisma.review.create({
        data: {
          hireId: hire.id,
          authorId: familyId,
          targetId: caregiverId,
          rating: hireSeed.review.rating,
          comment: hireSeed.review.comment,
        },
      });
    }
  }
}

function printCredentialsTable() {
  const rows = [
    ...FAMILY_SEEDS.map((seed) => ({
      Nome: seed.name,
      Email: seed.email,
      Senha: DEMO_PASSWORD,
      Role: "FAMILY",
    })),
    ...CAREGIVER_SEEDS.map((seed) => ({
      Nome: seed.name,
      Email: seed.email,
      Senha: DEMO_PASSWORD,
      Role: "CAREGIVER",
    })),
  ];

  console.log("\n=== Credenciais de demonstração (mesma senha para todos) ===\n");
  console.table(rows);
}

async function main() {
  console.log("=== Limpando dados de demonstração anteriores ===");
  const removedCount = await cleanup();
  console.log(`Usuários demo removidos: ${removedCount}\n`);

  console.log("=== Criando cuidadores (geocodificando via Nominatim, ~1 req/s) ===");
  const hashedPassword = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_SALT_ROUNDS);
  const caregiverIdByEmail = await seedCaregivers(hashedPassword);
  console.log(`${CAREGIVER_SEEDS.length} cuidadores criados.\n`);

  console.log("=== Criando famílias (geocodificando via Nominatim, ~1 req/s) ===");
  const familyIdByEmail = await seedFamilies(hashedPassword);
  console.log(`${FAMILY_SEEDS.length} famílias criadas.\n`);

  console.log("=== Criando histórico de contratações e avaliações ===");
  await seedHires(familyIdByEmail, caregiverIdByEmail);
  console.log(
    `${HIRE_SEEDS.length} contratações criadas ` +
      `(${HIRE_SEEDS.filter((h) => h.review).length} com avaliação).\n`
  );

  printCredentialsTable();
}

// Protegido para que scripts/cleanup-demo.ts consiga fazer
// `import { cleanup }` deste arquivo (para reaproveitar exatamente a mesma
// lógica) sem também disparar uma execução completa de seed como efeito
// colateral do import.
if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
