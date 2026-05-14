.PHONY: build run clean shell setup
.ONESHELL:

# Gather the current users real username and UID/GID so we can use it within the container
export REAL_USER := $(or $(SUDO_USER),$(shell whoami))
export HOST_UID := $(shell id -u $(REAL_USER))
export HOST_GID := $(shell id -g $(REAL_USER))
export COMPOSE_PROJECT_NAME := $(REAL_USER)

export PARANOID_MODE ?= true
export WORKDIR ?= .
SVC ?= pi


usage:
	@cat <<EOF
	Usage: make [options] [target]
	
	Available targets:
	  build      Build docker container
	  update     Build a fresh container with no cache
	  clean      Remove generated files
	  usage      Show this help message
	  run        Run the default pi context
	  shell      Start the container in bash
	
	Common options:
	  SVC=claude		The composer service to run (default: pi)
	  WORKDIR=/some/path	The workspace dir to mount into the container (default: .)
	
	Examples:
	  make SVC=claude WORKDIR=/opt/dev/mpascoe run

	EOF

help: usage

setup:
	@mkdir -p ~/.claude
	@chmod 755 ~/.claude
	@chown -R $$HOST_UID:$$HOST_GID ~/.claude

build: setup
	docker compose build $(SVC)

update: setup
	docker compose build --no-cache $(SVC)

run: setup
	docker compose run --rm $(SVC)

run-args: setup
	docker compose run --rm $(SVC) $(args)

shell: setup
	docker compose run --rm --entrypoint /bin/bash $(SVC)

clean:
	docker compose down $(SVC)
