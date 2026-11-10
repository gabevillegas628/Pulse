declare module 'smiles-drawer' {
  const SmilesDrawerNS: {
    SmiDrawer: new (options: { width: number; height: number }) => {
      draw: (smiles: string, target: SVGSVGElement | HTMLCanvasElement | null, theme: string, successCallback?: null, errorCallback?: null) => void
    }
  }
  export default SmilesDrawerNS
}

// Vite's `?url` imports: the asset's public URL (used for the pdf.js worker).
declare module '*?url' {
  const url: string
  export default url
}
