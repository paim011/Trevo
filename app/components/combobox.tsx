"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import { inputClass } from "@/lib/ui";

export type ComboboxOption = { value: string; label: string };

type ComboboxProps = {
  id: string;
  value: string;
  options: ComboboxOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  emptyMessage?: string;
};

// Comparação sem sensibilidade a acento, para que "goias"/"sao paulo" (sem
// acentos -- comum quando se digita rápido) ainda encontre "Goiás"/"São
// Paulo".
function normalizeForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

// Combobox acessível de seleção única e pesquisável (padrão ARIA 1.2
// "combobox with list autocomplete"), usado por baixo dos campos
// Estado/Cidade em app/components/location-fields.tsx. Ao contrário de um
// <select> nativo, permite ao usuário filtrar uma lista longa de opções
// digitando -- mas ao contrário de um <input> comum, o valor que de fato
// chega em `onChange` só pode ser um dos `options`: texto livre que não bate
// com nada é descartado no blur (revertido para a última seleção válida),
// nunca propagado como valor.
export function Combobox({
  id,
  value,
  options,
  onChange,
  placeholder,
  disabled = false,
  required = false,
  emptyMessage = "Nenhum resultado",
}: ComboboxProps) {
  const listboxId = `${id}-listbox`;

  const selectedOption = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value]
  );

  const [query, setQuery] = useState(selectedOption?.label ?? "");
  const [isOpen, setIsOpen] = useState(false);
  const [hasUserTyped, setHasUserTyped] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // Mantém o texto exibido sincronizado quando a seleção muda a partir de
  // fora (ex.: LocationFields resetando a cidade para "" quando o estado
  // muda). Ajuste feito durante a renderização, comparando com o valor
  // anterior, em vez de um useEffect -- evita uma segunda renderização em
  // cascata (padrão "ajustar estado quando uma prop muda" da documentação
  // do React).
  const [previousSelected, setPreviousSelected] = useState(selectedOption);
  if (selectedOption !== previousSelected) {
    setPreviousSelected(selectedOption);
    setQuery(selectedOption?.label ?? "");
    setHasUserTyped(false);
  }

  const filteredOptions = useMemo(() => {
    if (!hasUserTyped || !query.trim()) return options;
    const needle = normalizeForSearch(query);
    return options.filter((option) => normalizeForSearch(option.label).includes(needle));
  }, [options, query, hasUserTyped]);

  // Volta o destaque para a primeira opção sempre que a lista filtrada muda.
  const [previousFiltered, setPreviousFiltered] = useState(filteredOptions);
  if (filteredOptions !== previousFiltered) {
    setPreviousFiltered(filteredOptions);
    setHighlightedIndex(0);
  }

  function commit(option: ComboboxOption | null) {
    onChange(option?.value ?? "");
    setQuery(option?.label ?? "");
    setHasUserTyped(false);
    setIsOpen(false);
  }

  function handleBlur() {
    // Uma correspondência exata (sem sensibilidade a acento/maiúsculas) no
    // blur ainda conta como uma seleção, então sair com Tab logo depois de
    // digitar um nome válido por completo funciona -- qualquer outra coisa
    // reverte para a última seleção válida em vez de deixar texto livre
    // vazar para o estado do formulário.
    const typed = normalizeForSearch(query);
    const exactMatch = options.find((option) => normalizeForSearch(option.label) === typed);
    commit(exactMatch ?? selectedOption);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIsOpen(true);
      setHighlightedIndex((index) =>
        filteredOptions.length === 0 ? 0 : (index + 1) % filteredOptions.length
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setIsOpen(true);
      setHighlightedIndex((index) =>
        filteredOptions.length === 0
          ? 0
          : (index - 1 + filteredOptions.length) % filteredOptions.length
      );
      return;
    }

    if (event.key === "Enter") {
      // Também impede que isso submeta o <form> ao redor.
      if (isOpen) {
        event.preventDefault();
        const chosen = filteredOptions[highlightedIndex];
        if (chosen) commit(chosen);
      }
      return;
    }

    if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      setQuery(selectedOption?.label ?? "");
      setHasUserTyped(false);
      setIsOpen(false);
    }
  }

  const activeOptionId =
    isOpen && filteredOptions[highlightedIndex]
      ? `${id}-option-${filteredOptions[highlightedIndex].value}`
      : undefined;

  return (
    <div className="relative">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId}
        autoComplete="off"
        required={required}
        disabled={disabled}
        placeholder={placeholder}
        value={query}
        onFocus={() => setIsOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setHasUserTyped(true);
          setIsOpen(true);
        }}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        className={inputClass}
      />

      {isOpen && !disabled && (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-muted/40 bg-white py-1 shadow-sm"
        >
          {filteredOptions.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted">{emptyMessage}</li>
          )}
          {filteredOptions.map((option, index) => (
            <li
              key={option.value}
              id={`${id}-option-${option.value}`}
              role="option"
              aria-selected={option.value === value}
              onMouseDown={(event) => {
                // Impede que o input perca o foco antes do clique ser
                // processado -- sem isso, o dropdown seria desmontado
                // (isOpen -> false via blur) antes do onClick sequer disparar.
                event.preventDefault();
                commit(option);
              }}
              onMouseEnter={() => setHighlightedIndex(index)}
              className={`cursor-pointer px-3 py-2 text-sm ${
                index === highlightedIndex ? "bg-primary text-white" : "text-ink hover:bg-primary-light"
              }`}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
