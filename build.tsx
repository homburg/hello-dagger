import {
  Client,
  Container,
  Directory,
  GraphQLRequestError,
  connect,
} from "@dagger.io/dagger";

const rtx_version = "v2023.10.1";

connect(
  async (client) => {
    // create a cache volume
    const node_cache = client.cacheVolume("node");

    const platform = await client.defaultPlatform();

    const arch = platform.includes("arm64") ? "arm64" : "x64";

    const worker = worker_container(client);

    const rtx = await rtx_container(client, await worker(), arch);

    const base = (await worker()).withFile(
      "/usr/local/bin/rtx",
      (await rtx()).file("rtx/bin/rtx")
    );

    const base_excludes = ["tmp", "**/node_modules"];

    const source_directory = client
      .host()
      .directory(".", { exclude: [...base_excludes] });

    const builder = base
      .withDirectory(".", source_directory)
      .withExec([
        "sh",
        "-c",
        ["rtx install --yes", "rtx cache clear"].join(" && "),
      ]);

    const diff = await base.directory("/").diff(builder.directory("/"));

    await diff.sync();
    // await diff.export("tmp/builder-diff");

    return;

    // use a node:16-slim container
    // mount the source code directory on the host
    // at /src in the container
    // mount the cache volume to persist dependencies
    const source = client
      .container()
      .from("node:16-slim")
      .withDirectory("/src", client.host().directory("."), {
        exclude: ["node_modules/", "ci/"],
      })
      .withMountedCache("/src/node_modules", node_cache);

    // set the working directory in the container
    // install application dependencies
    const runner = source.withWorkdir("/src").withExec(["npm", "install"]);

    // run application tests
    const test = runner.withExec(["npm", "test", "--", "--watchAll=false"]);

    // first stage
    // build application
    const buildDir = test
      .withExec(["npm", "run", "build"])
      .directory("./build");

    // second stage
    // use an nginx:alpine container
    // copy the build/ directory from the first stage
    // publish the resulting container to a registry
    // await publishNginxImage(client, buildDir);
  },
  { LogOutput: process.stdout }
);

async function rtx_container(client: Client, worker: Container, arch: string) {
  let container: Container;
  return async () => {
    if (!process.env.REGISTRY) {
      return new_rtx_container(worker, arch);
    }
    container =
      container || (await new_published_rtx_container(client, worker, arch));
    return container;
  };
}

async function new_published_rtx_container(
  client: Client,
  worker: Container,
  arch: string
) {
  const rtx_image_name = process.env.REGISTRY
    ? `${process.env.REGISTRY}/${process.env.IMAGE_NAME}/rtx:${rtx_version}`
    : "";

  const rtx = await client
    .container()
    .from(rtx_image_name)
    .sync()
    .catch(async (e) => {
      if (!is_image_not_found_error(e)) {
        throw e;
      }

      const c = new_rtx_container(worker, arch);

      await c.publish(rtx_image_name);

      return c;
    });
  return rtx;
}

function new_rtx_container(worker: Container, arch: string) {
  return worker
    .withExec([
      "sh",
      "-c",
      ["apt-get update", "apt-get install -y xz-utils"].join(" && "),
    ])
    .withExec(
      `curl -L https://github.com/jdx/rtx/releases/download/${rtx_version}/rtx-${rtx_version}-linux-${arch}.tar.xz -o rtx.tar.xz`.split(
        /\s+/
      )
    )
    .withExec("tar xvf rtx.tar.xz".split(/\s+/));
}

function worker_container(client: Client) {
  let container: Container;
  return async () => {
    if (!process.env.REGISTRY) {
      return new_worker_container(client);
    }
    container = container || (await new_published_worker_container(client));
    return container;
  };
}

async function new_published_worker_container(client: Client) {
  const worker_image_name = process.env.REGISTRY
    ? `${process.env.REGISTRY}/${process.env.IMAGE_NAME}/worker`
    : "";

  return await client
    .container()
    .from(worker_image_name)
    .sync()
    .catch(async (e) => {
      if (!is_image_not_found_error(e)) {
        throw e;
      }

      const c = new_worker_container(client);

      await c.publish(worker_image_name);

      return c;
    });
}

function new_worker_container(client: Client) {
  return client
    .container()
    .from("ubuntu")
    .withWorkdir("/wrk")
    .withExec([
      "sh",
      "-c",
      "apt-get update && apt-get install --yes unzip curl git",
    ]);
}

function is_image_not_found_error(e: unknown) {
  return e instanceof GraphQLRequestError && e.message.includes("not found");
}

async function publishNginxImage(client: Client, buildDir: Directory) {
  const imageRef = await client
    .container()
    .from("nginx:1.23-alpine")
    .withDirectory("/usr/share/nginx/html", buildDir)
    .publish("ttl.sh/hello-dagger-" + Math.floor(Math.random() * 10000000));
  console.log(`Published image to: ${imageRef}`);
}
