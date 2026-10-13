import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M4 12H16V16H4Z" fill="var(--icon-weak-base)" />
      <path
        data-slot="logo-logo-mark-o"
        d="M0 0H16V4H0ZM0 4H4V8H0ZM12 4H16V8H12ZM0 8H16V12H0ZM0 12H4V16H0ZM0 16H16V20H0Z"
        fill="var(--icon-strong-base)"
      />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M20 60H80V80H20Z" fill="var(--icon-base)" />
      <path
        d="M0 0H80V20H0ZM0 20H20V40H0ZM60 20H80V40H60ZM0 40H80V60H0ZM0 60H20V80H0ZM0 80H80V100H0Z"
        fill="var(--icon-strong-base)"
      />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 264 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g>
        <path d="M6 24H24V30H6Z" fill="var(--icon-weak-base)" />
        <path
          d="M0 6H24V12H0ZM0 12H6V18H0ZM18 12H24V18H18ZM0 18H24V24H0ZM0 24H6V30H0ZM0 30H24V36H0Z"
          fill="var(--icon-base)"
        />
        <path d="M36 18H48V30H36Z" fill="var(--icon-weak-base)" />
        <path
          d="M30 6H54V12H30ZM30 12H36V30H30ZM48 12H54V30H48ZM30 30H54V36H30ZM48 36H54V42H48Z"
          fill="var(--icon-base)"
        />
        <path d="M66 12H78V30H66Z" fill="var(--icon-weak-base)" />
        <path d="M60 6H66V30H60ZM78 6H84V30H78ZM60 30H84V36H60Z" fill="var(--icon-base)" />
        <path d="M96 24H114V30H96Z" fill="var(--icon-weak-base)" />
        <path
          d="M90 6H114V12H90ZM90 12H96V18H90ZM108 12H114V18H108ZM90 18H114V24H90ZM90 24H96V30H90ZM90 30H114V36H90Z"
          fill="var(--icon-base)"
        />
        <path d="M126 24H144V30H126Z" fill="var(--icon-weak-base)" />
        <path
          d="M120 0H144V6H120ZM138 6H144V18H138ZM120 18H144V24H120ZM120 24H126V30H120ZM120 30H144V36H120Z"
          fill="var(--icon-base)"
        />
        <path d="M156 18H174V30H156Z" fill="var(--icon-weak-base)" />
        <path d="M150 6H174V12H150ZM150 12H156V30H150ZM150 30H174V36H150Z" fill="var(--icon-strong-base)" />
        <path d="M186 18H198V30H186Z" fill="var(--icon-weak-base)" />
        <path
          d="M180 6H204V12H180ZM180 12H186V30H180ZM198 12H204V30H198ZM180 30H204V36H180Z"
          fill="var(--icon-strong-base)"
        />
        <path d="M216 18H228V30H216Z" fill="var(--icon-weak-base)" />
        <path
          d="M228 0H234V6H228ZM210 6H234V12H210ZM210 12H216V30H210ZM228 12H234V30H228ZM210 30H234V36H210Z"
          fill="var(--icon-strong-base)"
        />
        <path d="M246 24H264V30H246Z" fill="var(--icon-weak-base)" />
        <path
          d="M240 6H264V12H240ZM240 12H246V18H240ZM258 12H264V18H258ZM240 18H264V24H240ZM240 24H246V30H240ZM240 30H264V36H240Z"
          fill="var(--icon-strong-base)"
        />
      </g>
    </svg>
  )
}
