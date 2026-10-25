# How the map decides where the trucks go

This is what Calculate does on the satellite map.

## Where the trucks start

Lusaka is the capital of Zambia. The national medicines store is there. Eastern Province does not send a truck from Lusaka for a village round. The province's stock sits at the Chipata regional store, and each district keeps a pickup at its own district centre: Katete, Petauke, Sinda, Nyimba, Lundazi, Chadiza, Mfuwe, Vubwi, Chama, Lumezi, and Kasenengwa.

Calculate sends the pickups that are working, and the Chipata trucks as well, when a Chipata truck can cover a different road. Two trucks are not sent down the same road. Motorbikes, bicycles, boats, and drones stay parked. A vehicle marked down stays parked too.

The green ring labeled Chipata store is the regional store. It is not a delivery. Chipata is the only stocked post, so there is no green routine round.

A truck may refuel at a district town or at the Chipata store. A long road inside its own district is kept. A road that wanders off across the country is not used, and those dots are offered to a truck whose road actually passes near them.

## Which dots light up

Calculate picks about 2,300 of the settlements at random, about a tenth of the settlements on the map. The next click picks a different set.

A dot lights only when a truck can reach it. If it is farther than 40 kilometres from every road in this wave, it stays dark. There are no uncovered red dots left on the map. When that truck's stitches land, those dots shrink away. The finished province view has the roads and the dashes, not a field of dots.

## What you see from the back of the room

Each truck has its own colour, so you can tell the roads apart from across the room. Lundazi's road is amber and tagged "running low". Every other truck is tagged "emergency", in its own colour, not a row of identical reds.

A large label sits on each road: the district, the truck, and how many villages that truck covers, written as words ("231 villages"), including the ones it reaches with a hop. The name is placed on the stretch of road that belongs to that truck, so the labels do not pile up where the highways meet at Chipata. The same colour, district, truck, and count sit in a list on the right. A small box next to that list hides every name and label, so only the lines and the dots remain. Click it again and the names come back. The lines stay. A small mark sits on the store that truck leaves from: a district pickup leaves from its own town, and a Chipata truck leaves from the Chipata store. Where two trucks share the highway out of Chipata, the lines sit side by side so you can see them split. They are not three copies of one stroke.

When you press Calculate, the camera moves in close enough for the small white settlement freckles to draw, then eases slightly back out so they stay on screen. That is the same move as zooming in and then a little back out. It stays high enough to see a district cluster, not down at street level. Then the villages that wave can reach flash red. The other white freckles disappear. The red ones stay and pulse slowly. No road is on the map yet.

While they pulse, the top right says "Listening · tracking pods and requests." Then one notice at a time, about two seconds each, and each one leaves before the next. Each notice shows that organisation's own logo: the NASA meatball for the flood map (MODIS and VIIRS), the OpenStreetMap logo for the roads, the Open-Meteo logo for the rain, the Copernicus logo for the GloFAS river forecast, and the Esri logo for the satellite picture already on the globe. A notice appears only if that source was actually asked. They do not stay piled in the corner. The corner keeps one quiet line: "Live · saved through the routing."

Only after the last logo has left do the roads draw. Each thick road grows from that truck's own store along the real OpenStreetMap road, one truck after another. The label and the row in the list appear when that road finishes. As that road finishes, that truck's dashed stitches grow out from the road to its villages within 40 kilometres, and those red dots shrink to nothing as the stitches land. The camera then eases back out over the province. The dashes are still on the map, thick enough to see from there, with visible gaps. The roads and the dashes are bright, with a soft coloured bloom, and each truck keeps its own colour. You do not click a truck to see the dashes.

A button at the bottom left, "Route reasoning", opens the decisions for this wave: how many settlements were called, how many a truck reached, why each truck rolled, where it leaves from, the kilometres, the 40 kilometre stitches, the live flood outlook, and, if a flood moved a truck, which road it left and which road it took. Those are the sentences the planner already computed.

## How a truck chooses a road

Each called dot is handed to the nearest district pickup. The three largest districts are split in half. The pickup takes one half. A Chipata truck takes the other half, but only when OpenStreetMap draws that half on a different road. If the two roads would lie on top of each other, the Chipata truck stays put and the pickup's road covers whatever is within 40 kilometres.

The truck drives a real OpenStreetMap road through a spread of villages in its half. There is no Google key, so nothing is drawn as a straight line and called a road. The thick line is that road. It is drawn only after the logo notices have left, and it grows out from the store.

## The dashed lines

The dashed stitches are drawn at the end of each truck inside Calculate, not on a later click. When a thick road finishes, that truck's stitches grow from the road out to the surrounding villages within 40 kilometres. Each stitch is the same colour family as the truck, with a visible gap, and it ends where the village was. The red dot shrinks away as the stitch lands. Every truck's stitches stay on the map when Calculate finishes and the view pulls back. A dot farther than 40 kilometres stays off. Click a truck if you want the view to fly in on that road; the stitches are already there.

The dots, the stitches, the logos in the notices, and the labels sit so they do not slide off the ground when you zoom. Anything drawn on the globe is at altitude 0.

## What you read on the map

The sources are not a stack of names in the corner. During Calculate they take turns at the top right, one logo at a time: the NASA meatball, the OpenStreetMap logo, the Open-Meteo logo, the Copernicus logo for GloFAS, and the Esri logo. After they leave, the corner keeps the one line "Live · saved through the routing." Route reasoning, at the bottom left, is where the flood outlook and each truck's reason are written out.

NASA POWER is the longer rain history used on the government page. Calculate does not call it, so it never appears in that sequence.

The live feed says, in plain language, how many dots were called, how many trucks rolled, the kilometres, and that the dashed lines are the hops within 40 kilometres.

Hamlet names stay hidden until Names is on. The Eastern Province panel and the live feed close on their own.

## Floods

Recalculate floods reads the live outlook: Open-Meteo rain, the GloFAS river forecast, and NASA's flood map. If that outlook is dry, the map says so. It still draws one real second road, where OpenStreetMap has another way between two stops. That wet stretch is a thin blue line with a label, not a blue polygon. Click the label and the view flies in so both roads are in frame. The truck takes the other road. The same dots stay covered.
