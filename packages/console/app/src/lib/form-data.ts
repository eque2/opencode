// FormData.get returns a File for file inputs; server actions here only read text fields.
export function formText(form: FormData, key: string) {
  const value = form.get(key)
  return typeof value === "string" ? value : null
}
