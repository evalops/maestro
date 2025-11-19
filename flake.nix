{
  description = "Composer CLI - AI-assisted development tool";

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
          pname = "composer-cli";
          version = "0.10.0";

          src = ./.;

          npmDepsHash = "sha256-CKjvjbH+Tdxyh/zj1Ly4pgVC9NlfxAMxooXQwN75SvM=";

          nativeBuildInputs = with pkgs; [
            nodejs
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
            description = "Composer CLI by EvalOps with rich tooling for AI-assisted development";
            homepage = "https://github.com/evalops/composer-cli";
            license = licenses.mit;
            maintainers = [ ];
            platforms = platforms.unix;
          };
        };

      in {
        packages = {
          default = composer;
          composer-cli = composer;
        };

        apps.default = {
          type = "app";
          program = "${composer}/bin/composer";
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs
            nodePackages.npm
            nodePackages.typescript
            git
            gh  # GitHub CLI
          ];

          shellHook = ''
            echo "Composer CLI development environment"
            echo "Node: $(node --version)"
            echo "npm: $(npm --version)"
            echo ""
            echo "Available commands:"
            echo "  npm install    - Install dependencies"
            echo "  npm run build  - Build the project"
            echo "  npm test       - Run tests"
            echo "  npm run dev    - Watch mode"
            echo "  npm run lint   - Run linter"
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
