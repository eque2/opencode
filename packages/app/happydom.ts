import { GlobalRegistrator } from "@happy-dom/global-registrator"

GlobalRegistrator.register()

// oxlint-disable-next-line unbound-method -- the HTMLCanvasElement.prototype.getContext mock below keeps happy-dom's method detached and calls it with call(this, ...) for other context types
const originalGetContext = HTMLCanvasElement.prototype.getContext
// happy-dom has no canvas backend, so tests get a simplified 2D context. The mock covers only the members that
// tests use and is not a full CanvasRenderingContext2D, so it is installed as a property value, not typed as one.
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  writable: true,
  value: function (this: HTMLCanvasElement, contextType: string, _options?: unknown) {
    if (contextType === "2d") {
      return {
        canvas: this,
        fillStyle: "#000000",
        strokeStyle: "#000000",
        font: "12px monospace",
        textAlign: "start",
        textBaseline: "alphabetic",
        globalAlpha: 1,
        globalCompositeOperation: "source-over",
        imageSmoothingEnabled: true,
        lineWidth: 1,
        lineCap: "butt",
        lineJoin: "miter",
        miterLimit: 10,
        shadowBlur: 0,
        shadowColor: "rgba(0, 0, 0, 0)",
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        fillRect: () => {},
        strokeRect: () => {},
        clearRect: () => {},
        fillText: () => {},
        strokeText: () => {},
        measureText: (text: string) => ({ width: text.length * 8 }),
        drawImage: () => {},
        save: () => {},
        restore: () => {},
        scale: () => {},
        rotate: () => {},
        translate: () => {},
        transform: () => {},
        setTransform: () => {},
        resetTransform: () => {},
        createLinearGradient: () => ({ addColorStop: () => {} }),
        createRadialGradient: () => ({ addColorStop: () => {} }),
        createPattern: () => null,
        beginPath: () => {},
        closePath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        bezierCurveTo: () => {},
        quadraticCurveTo: () => {},
        arc: () => {},
        arcTo: () => {},
        ellipse: () => {},
        rect: () => {},
        fill: () => {},
        stroke: () => {},
        clip: () => {},
        isPointInPath: () => false,
        isPointInStroke: () => false,
        getTransform: () => ({}),
        getImageData: () => ({
          data: new Uint8ClampedArray(0),
          width: 0,
          height: 0,
        }),
        putImageData: () => {},
        createImageData: () => ({
          data: new Uint8ClampedArray(0),
          width: 0,
          height: 0,
        }),
      }
    }
    return originalGetContext.call(this, contextType, _options)
  },
})
