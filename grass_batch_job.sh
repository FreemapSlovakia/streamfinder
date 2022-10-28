v.in.ogr min_area=0.0001 snap=-1.0 input="streams8.shp" output="my_vector" --overwrite -o
v.generalize input=my_vector type="line,boundary,area" method="chaiken" threshold=1 look_ahead=7 reduction=50 slide=0.5 angle_thresh=3 degree_thresh=0 closeness_thresh=0 betweeness_thresh=0 alpha=1 beta=1 iterations=1 -l output=my_output --overwrite
v.out.ogr type="auto" input="my_output" output="smooth.gpkg" format="GPKG" --overwrite
