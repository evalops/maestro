{
  description = "Maestro native Rust coding agent";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };
  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        maestro = pkgs.rustPlatform.buildRustPackage {
          pname = "maestro";
          version = "0.10.54";
          src = ./.;
          cargoRoot = ".";
          cargoLock.lockFile = ./Cargo.lock;
        };
      in {
        packages.default = maestro;
        apps.default = { type = "app"; program = "${maestro}/bin/maestro"; };
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [ cargo rustc rustfmt clippy nodejs git gh ];
        };
        formatter = pkgs.nixpkgs-fmt;
      });
}
