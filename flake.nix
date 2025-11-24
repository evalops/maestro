{
  description = "Composer - AI-assisted development tool with TUI/CLI and Web UI";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        nodejs = pkgs.nodejs_20;
        
        composer = pkgs.buildNpmPackage rec {
          pname = "composer";
          version = "0.10.0";

          src = ./.;

          npmDepsHash = "sha256-gCSMcIzNDBPX2F4VIsTQ206B3Anny3kc6qDWsVreBYM=";

          nativeBuildInputs = with pkgs; [
            nodejs
            bun
            makeWrapper
          ];

          buildPhase = ''
            runHook preBuild
            
            # Build workspace packages first (TUI must be built before root)
            npm run build --workspace=@evalops/tui
            
            # Build root package
            npm run build
            
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            
            mkdir -p $out/bin $out/lib/node_modules/@evalops/composer
            
            # Copy built files (root package)
            cp -r dist $out/lib/node_modules/@evalops/composer/
            cp -r node_modules $out/lib/node_modules/@evalops/composer/
            cp package.json $out/lib/node_modules/@evalops/composer/
            
            # Copy workspace packages with their built artifacts
            mkdir -p $out/lib/node_modules/@evalops/composer/packages
            cp -r packages/tui $out/lib/node_modules/@evalops/composer/packages/
            cp -r packages/web $out/lib/node_modules/@evalops/composer/packages/
            
            # Create wrapper script
            makeWrapper ${nodejs}/bin/node $out/bin/composer \
              --add-flags "$out/lib/node_modules/@evalops/composer/dist/cli.js"
            
            runHook postInstall
          '';

          meta = with pkgs.lib; {
            description = "Composer by EvalOps - Deterministic coding agent with TUI/CLI and Web UI";
            homepage = "https://github.com/evalops/composer";
            license = licenses.mit;
            maintainers = [ ];
            platforms = platforms.unix;
          };
        };

      in {
        packages = {
          default = composer;
          composer = composer;
        };

        apps.default = {
          type = "app";
          program = "${composer}/bin/composer";
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs
            bun
            nodePackages.npm
            nodePackages.typescript
            git
            gh  # GitHub CLI
          ];

          shellHook = ''
            echo "Composer development environment"
            echo "Node: $(node --version)"
            echo "npm: $(npm --version)"
            echo ""
            echo "Available commands:"
            echo "  npm install      - Install dependencies"
            echo "  npm run build:all - Build CLI, TUI, and Web UI"
            echo "  npm test         - Run tests"
            echo "  npm run dev      - Watch mode"
            echo "  npm run web:dev  - Web UI dev mode"
            echo "  npm run lint     - Run linter"
            echo ""
            
            # Set up development environment
            export NODE_ENV=development
          '';
        };

        # Formatter for nix files
        formatter = pkgs.nixpkgs-fmt;
      }
    );
}
