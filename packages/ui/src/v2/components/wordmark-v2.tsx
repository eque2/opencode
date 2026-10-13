import { createUniqueId, type ComponentProps } from "solid-js"

export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 812.3077 129"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g opacity="0.6">
        <g mask={`url(#${mask})`}>
          <g opacity="0.16">
            <path
              opacity="0.7"
              d="M0 18.4286H73.8462V36.8571H0ZM0 36.8571H18.4615V55.2857H0ZM55.3846 36.8571H73.8462V55.2857H55.3846ZM0 55.2857H73.8462V73.7143H0ZM0 73.7143H18.4615V92.1429H0ZM0 92.1429H73.8462V110.5714H0Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M92.3077 18.4286H166.1538V36.8571H92.3077ZM92.3077 36.8571H110.7692V92.1429H92.3077ZM147.6923 36.8571H166.1538V92.1429H147.6923ZM92.3077 92.1429H166.1538V110.5714H92.3077ZM147.6923 110.5714H166.1538V129H147.6923Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M184.6154 18.4286H203.0769V92.1429H184.6154ZM240 18.4286H258.4615V92.1429H240ZM184.6154 92.1429H258.4615V110.5714H184.6154Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M276.9231 18.4286H350.7692V36.8571H276.9231ZM276.9231 36.8571H295.3846V55.2857H276.9231ZM332.3077 36.8571H350.7692V55.2857H332.3077ZM276.9231 55.2857H350.7692V73.7143H276.9231ZM276.9231 73.7143H295.3846V92.1429H276.9231ZM276.9231 92.1429H350.7692V110.5714H276.9231Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M369.2308 0H443.0769V18.4286H369.2308ZM424.6154 18.4286H443.0769V55.2857H424.6154ZM369.2308 55.2857H443.0769V73.7143H369.2308ZM369.2308 73.7143H387.6923V92.1429H369.2308ZM369.2308 92.1429H443.0769V110.5714H369.2308Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M461.5385 18.4286H535.3846V36.8571H461.5385ZM461.5385 36.8571H480V92.1429H461.5385ZM461.5385 92.1429H535.3846V110.5714H461.5385Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M553.8462 18.4286H627.6923V36.8571H553.8462ZM553.8462 36.8571H572.3077V92.1429H553.8462ZM609.2308 36.8571H627.6923V92.1429H609.2308ZM553.8462 92.1429H627.6923V110.5714H553.8462Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M701.5385 0H720V18.4286H701.5385ZM646.1538 18.4286H720V36.8571H646.1538ZM646.1538 36.8571H664.6154V92.1429H646.1538ZM701.5385 36.8571H720V92.1429H701.5385ZM646.1538 92.1429H720V110.5714H646.1538Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M738.4615 18.4286H812.3077V36.8571H738.4615ZM738.4615 36.8571H756.9231V55.2857H738.4615ZM793.8462 36.8571H812.3077V55.2857H793.8462ZM738.4615 55.2857H812.3077V73.7143H738.4615ZM738.4615 73.7143H756.9231V92.1429H738.4615ZM738.4615 92.1429H812.3077V110.5714H738.4615Z"
              fill="currentColor"
            />
          </g>
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="812.3077" height="129">
          <rect width="812.3077" height="129" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="406.1538" y1="68" x2="406.1538" y2="129" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
