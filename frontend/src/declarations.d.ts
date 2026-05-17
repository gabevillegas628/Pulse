declare module 'smiles-drawer' {
  const SmilesDrawerNS: {
    SmiDrawer: new (options: { width: number; height: number }) => {
      draw: (smiles: string, target: SVGSVGElement | HTMLCanvasElement | null, theme: string, successCallback?: null, errorCallback?: null) => void
    }
  }
  export default SmilesDrawerNS
}
