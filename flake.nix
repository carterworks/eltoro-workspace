{
  description = "El Toro application workspace";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in
    {
      devShells.${system}.default = pkgs.mkShellNoCC {
        packages = with pkgs; [
          nodejs_24
          (pnpm.override { nodejs-slim = nodejs_24; })
          git
          ripgrep
          fd
          openssh
        ];
      };
    };
}
